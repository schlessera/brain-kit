#!/usr/bin/env node
/**
 * #1010 (V1 of #578): where does the committed audio boundary land when a
 * recording is interrupted?
 *
 * A throwaway measurement probe, outside every published package. It records
 * from a deterministic fake microphone with MediaRecorder, writes every chunk
 * in its own IndexedDB transaction together with the index's
 * `savedThroughMs` (page.js), interrupts the recording, and then reads what
 * survived from a fresh tab or a relaunched browser on the same profile.
 *
 * Loss for one run = (wall time of the interruption - recorder start) -
 * savedThroughMs from the index that survived. The interruption time is taken
 * by this runner (kills, hides, freezes) or by the page (track end, failed
 * write); both read the container's one clock. A negative loss means the
 * last committed chunk was delivered after the interruption instant, i.e.
 * nothing captured before it was lost.
 *
 * It runs inside the pinned Playwright image, headed under Xvfb:
 *
 *   node scripts/probes/audio-commit-boundary/probe.mjs                # all engines, all cases, 5 runs
 *   node scripts/probes/audio-commit-boundary/probe.mjs --browsers=firefox --cases=kill-browser --runs=5
 *   node scripts/probes/audio-commit-boundary/probe.mjs --summarize=/tmp/v1-commit-boundary/results.jsonl
 *
 * Results go to --out (default /tmp/v1-commit-boundary): capabilities.json,
 * results.jsonl (one raw line per run) and summary.md.
 *
 * Deterministic source. Chromium reads a seeded 48 kHz WAV through
 * `--use-file-for-fake-audio-capture`; Firefox uses its built-in fake stream
 * (`media.navigator.streams.fake`). Neither touches host audio hardware.
 *
 * Two runner facts shape the cases (both found while building this probe):
 *
 * - Playwright enables `Emulation.setFocusEmulationEnabled` on every Chromium
 *   page it drives, and Chromium keeps an emulated-focus page "visible" even
 *   behind another tab. The hidden case therefore drives Chromium over raw
 *   CDP, without Playwright attached (`rawChromium`).
 *   A profile written that way must also be read back over raw CDP: Playwright
 *   launches Chromium with ThirdPartyStoragePartitioning disabled, and a
 *   Playwright relaunch did not see the IndexedDB rows a raw instance wrote.
 * - Chromium did not honour `Page.setWebLifecycleState: frozen` on a
 *   recording page (no `freeze` event; chunks kept arriving), so there is no
 *   freeze case; capabilities.json records that check instead.
 * - Quota: neither engine's estimate() is small enough to fill in a test, and
 *   Chromium's `Storage.overrideQuotaForOrigin` is not reflected in
 *   estimate(). Filling IndexedDB to the limit and deleting rows to make room
 *   does not work either: on a full disk Chromium's deletes fail with
 *   QuotaExceededError too. The quota case therefore puts the profile on a
 *   48 MiB tmpfs and, once the browser is up, writes a ballast file that
 *   leaves a few seconds of audio free: the device-nearly-full condition.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The pin shared with scripts/visual.mjs and the CI container. */
const IMAGE = "mcr.microsoft.com/playwright:v1.63.0-noble";
/** In-container tmpfs for the quota case's profiles. */
const SMALL_DISK = "/quota";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const ALL_CASES = ["close-tab", "crash-renderer", "kill-browser", "hidden-then-kill", "track-ended", "quota"];
const out = resolve(option("out", "/tmp/v1-commit-boundary"));

if (option("summarize")) {
  const file = resolve(option("summarize"));
  const runs = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const caps = JSON.parse(readFileSync(resolve(dirname(file), "capabilities.json"), "utf8"));
  process.stdout.write(summarize(runs, caps));
  process.exit(0);
}

if (!argv.includes("--inside")) {
  mkdirSync(out, { recursive: true });
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `v1-1010-probe-${process.pid}`,
      "--ipc=host",
      // xvfb-run waits for a signal from Xvfb, which it never sees as PID 1.
      "--init",
      // Only the in-container static server is reached.
      "--network=none",
      "--tmpfs",
      `${SMALL_DISK}:size=48m,mode=1777`,
      "--user",
      `${uid}:${gid}`,
      "-v",
      `${REPO}:/repo:ro`,
      "-v",
      `${out}:/out`,
      "-w",
      "/repo",
      "-e",
      "HOME=/tmp",
      IMAGE,
      "xvfb-run",
      "-a",
      "-s",
      "-screen 0 1280x800x24",
      "node",
      "scripts/probes/audio-commit-boundary/probe.mjs",
      "--inside",
      "--out=/out",
      ...argv.filter((a) => !a.startsWith("--out=")),
    ],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------- inside the image

const require = createRequire(resolve(REPO, "package.json"));
const playwright = require("playwright");

const browsers = option("browsers", "chromium,firefox,webkit").split(",");
const cases = option("cases", ALL_CASES.join(",")).split(",");
const runsPerCell = Number(option("runs", "5"));
const seed = Number(option("seed", "1010"));
const timesliceMs = Number(option("timeslice", "1000"));
mkdirSync(out, { recursive: true });

function prng(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded 48 kHz mono WAV: pitch and level step every 250 ms, plus noise. */
function writeWav(path, seconds) {
  const rate = 48000;
  const rand = prng(seed);
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  let phase = 0;
  let freq = 200;
  let level = 0.3;
  for (let i = 0; i < samples; i++) {
    if (i % (rate / 4) === 0) {
      freq = 140 + rand() * 260;
      level = rand() < 0.2 ? 0 : 0.2 + rand() * 0.5;
    }
    phase += (2 * Math.PI * freq) / rate;
    const v = Math.sin(phase) * level + (rand() * 2 - 1) * 0.05;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const wav = resolve(tmpdir(), "v1-source.wav");
writeWav(wav, 300);

const pageJs = readFileSync(resolve(HERE, "page.js"));
const server = createServer((req, res) => {
  if (req.url === "/page.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    res.end(pageJs);
    return;
  }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end('<!doctype html><title>V1 probe</title><script type="module" src="/page.js"></script>');
}).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const CHROMIUM_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${wav}`,
  "--autoplay-policy=no-user-gesture-required",
];

function launchOptions(name) {
  const common = { headless: false, viewport: { width: 1000, height: 700 } };
  if (name === "chromium") return { ...common, args: CHROMIUM_ARGS };
  if (name === "firefox")
    return { ...common, firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } };
  return { ...common, permissions: ["microphone"] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Playwright-driven browser on a persistent profile; `ev` evaluates an expression string in the probe tab. */
async function openPlaywright(name, dir) {
  const context = await playwright[name].launchPersistentContext(dir, launchOptions(name));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin);
  await page.waitForFunction(() => window.probeReady === true);
  return {
    kind: "playwright",
    context,
    page,
    version: context.browser()?.version() ?? null,
    ev: (expression) => page.evaluate(expression),
    close: () => context.close().catch(() => {}),
  };
}

/**
 * Chromium over raw CDP, with no Playwright session attached, so nothing
 * emulates focus and a background tab really reports `hidden`.
 */
async function rawChromium(dir) {
  // A killed instance leaves its port file behind; never connect to that one.
  rmSync(resolve(dir, "DevToolsActivePort"), { force: true });
  const proc = spawn(
    playwright.chromium.executablePath(),
    [`--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--password-store=basic", ...CHROMIUM_ARGS, "about:blank"],
    { stdio: "ignore" }
  );
  let endpoint;
  for (let i = 0; i < 200 && !endpoint; i++) {
    await sleep(50);
    try {
      const [port, path] = readFileSync(resolve(dir, "DevToolsActivePort"), "utf8").trim().split("\n");
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Not written yet.
    }
  }
  if (!endpoint) throw Error("raw Chromium did not expose a DevTools endpoint");
  const ws = new WebSocket(endpoint);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(Error(msg.error.message));
      else ok(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: ok, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send("Target.createTarget", { url: origin });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const ev = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  for (let i = 0; i < 100 && !(await ev("window.probeReady === true").catch(() => false)); i++) await sleep(50);
  const { product } = await send("Browser.getVersion");
  return {
    kind: "raw-cdp",
    version: product,
    ev,
    /** Open and focus a second tab in the same window. */
    hide: async () => {
      await send("Target.createTarget", { url: "about:blank", newWindow: false, background: false });
      await sleep(500);
      return (await ev("document.visibilityState")) === "hidden" ? "a second tab opened in front, in the same window (raw CDP)" : null;
    },
    close: async () => {
      await Promise.race([send("Browser.close").catch(() => {}), sleep(1000)]);
      ws.close();
      await sleep(300);
      proc.kill("SIGKILL");
    },
  };
}

function listProcesses() {
  const procs = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      let cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      // Firefox's fork server rewrites a content process's argv as one space-joined string.
      if (cmd.length === 1) cmd = cmd[0].split(" ");
      const ppid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]);
      procs.push({ pid: Number(pid), ppid, cmd });
    } catch {
      // Gone between readdir and read.
    }
  }
  return procs;
}

/** Every process whose command line names the profile, plus all their descendants. */
function profileProcesses(dir) {
  const procs = listProcesses();
  const set = new Set(procs.filter((p) => p.cmd.some((c) => c.includes(dir))).map((p) => p.pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs)
      if (set.has(p.ppid) && !set.has(p.pid)) {
        set.add(p.pid);
        grew = true;
      }
  }
  return procs.filter((p) => set.has(p.pid));
}

function sigkill(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** SIGKILL the whole browser: no unload, no shutdown, no flush. */
function killBrowser(dir) {
  const procs = profileProcesses(dir);
  if (!procs.length) throw Error(`no processes found for ${dir}`);
  sigkill(procs.map((p) => p.pid));
  return procs.length;
}

/** Kill only the tab's content process, leaving the browser process alive. */
async function crashRenderer(name, driver, dir) {
  if (name === "chromium") {
    const cdp = await driver.context.newCDPSession(driver.page);
    cdp.send("Page.crash").catch(() => {});
    return "CDP Page.crash on the recording tab";
  }
  // Firefox content processes come from its fork server; they name their parent with -parentPid.
  const parents = new Set(profileProcesses(dir).filter((p) => !p.cmd.includes("-contentproc")).map((p) => String(p.pid)));
  const all = listProcesses();
  const tabs = all.filter((p) => p.cmd.includes("-contentproc") && parents.has(p.cmd[p.cmd.indexOf("-parentPid") + 1]) && p.cmd.at(-1) === "tab");
  if (!tabs.length) throw Error(`no Firefox tab content process found among ${JSON.stringify(all.map((p) => [p.pid, p.ppid, p.cmd.slice(0, 2), p.cmd.at(-1)]))}`);
  sigkill(tabs.map((p) => p.pid));
  return `SIGKILL of the ${tabs.length} Firefox web-content ("tab") processes`;
}

const rand = prng(seed ^ 0x5eed);

async function waitDrained(driver, ms) {
  const until = Date.now() + ms;
  let snap;
  do {
    snap = await driver.ev("window.probe.snapshot()");
    if (snap.drained) return snap;
    await sleep(100);
  } while (Date.now() < until);
  return snap;
}

const START = `window.probe.start({ id: "rec", timesliceMs: ${timesliceMs}, mime: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined })`;

/** One run of one cell. Returns the raw record; `skipped` / `failed` say why a run produced no number. */
async function runOnce(name, kase, run) {
  const recordForMs = Math.round(3000 + rand() * 3000);
  const record = { browser: name, case: kase, run, recordForMs, timesliceMs };
  if (kase === "hidden-then-kill" && name !== "chromium")
    return {
      ...record,
      skipped: "could not hide the tab: Playwright opens every Firefox page in its own window, and Xvfb has no window manager to minimise or occlude it",
    };
  const dir = mkdtempSync(resolve(kase === "quota" ? SMALL_DISK : tmpdir(), `v1-${name}-${kase}-`));
  const driver = kase === "hidden-then-kill" ? await rawChromium(dir) : await openPlaywright(name, dir);
  record.browserVersion = driver.version;
  record.driver = driver.kind;
  let browserAlive = true;
  let ballast = null;
  let keeper = null;
  try {
    if (kase === "quota") {
      // Leave about recordForMs of opus free on the profile's disk; the recording then runs into it.
      // 256 KiB lets the index row and the first chunks commit; the rest is about recordForMs of opus.
      const headroom = 256 * 1024 + Math.round((recordForMs / 1000) * 17000);
      const { bavail, bsize } = statfsSync(SMALL_DISK);
      ballast = resolve(SMALL_DISK, `ballast-${name}-${run}`);
      writeFileSync(ballast, Buffer.alloc(Math.max(0, bavail * bsize - headroom), 1));
      record.quotaCondition = `profile on a 48 MiB tmpfs; a ballast file leaves ${headroom} bytes free before recording starts`;
      record.estimateBefore = await driver.ev("window.probe.estimate()");
    }
    record.started = await driver.ev(START);
    const startWall = record.started.startWall;

    if (kase === "quota") {
      const deadline = Date.now() + 60000;
      let snap;
      do {
        await sleep(200);
        snap = await driver.ev("window.probe.snapshot()");
      } while (!snap.writeErrors.length && Date.now() < deadline);
      if (!snap.writeErrors.length) return { ...record, before: snap, failed: "no chunk write failed within 60 s" };
      record.before = await waitDrained(driver, 5000);
      record.interruptWall = record.before.stopWall;
      record.interruptedBy = "the first failed chunk write; the probe then stops the recorder";
      record.killedProcesses = killBrowser(dir);
      browserAlive = false;
      // The reader relaunches after space was freed again, as after the user clears storage.
      rmSync(ballast, { force: true });
    } else {
      await sleep(recordForMs);
      if (kase === "close-tab") {
        // Firefox closes the browser window with its last page; keep a blank one open.
        keeper = await driver.context.newPage();
        await driver.page.bringToFront();
        record.before = await driver.ev("window.probe.snapshot()");
        record.interruptWall = Date.now();
        await driver.page.close({ runBeforeUnload: false });
        record.interruptedBy = "page.close without unload handlers; browser stays up";
      } else if (kase === "crash-renderer") {
        record.before = await driver.ev("window.probe.snapshot()");
        record.interruptWall = Date.now();
        record.interruptedBy = await crashRenderer(name, driver, dir);
      } else if (kase === "kill-browser") {
        record.before = await driver.ev("window.probe.snapshot()");
        record.interruptWall = Date.now();
        record.killedProcesses = killBrowser(dir);
        browserAlive = false;
        record.interruptedBy = "SIGKILL of every browser process";
      } else if (kase === "hidden-then-kill") {
        const how = await driver.hide();
        if (!how) return { ...record, skipped: "the recording tab still reported visible behind a second tab" };
        record.hiddenBy = how;
        record.hiddenAtMs = Date.now() - startWall;
        await sleep(6000);
        record.before = await driver.ev("window.probe.snapshot()");
        record.interruptWall = Date.now();
        record.killedProcesses = killBrowser(dir);
        browserAlive = false;
        record.interruptedBy = "SIGKILL of every browser process after 6 s hidden";
      } else if (kase === "track-ended") {
        record.interruptWall = await driver.ev("window.probe.interruptTrack()");
        record.before = await waitDrained(driver, 5000);
        record.killedProcesses = killBrowser(dir);
        browserAlive = false;
        record.interruptedBy = "MediaStreamTrack.stop() on the capture track; SIGKILL once the write chain drained (or after 5 s)";
      }
    }
    await sleep(500);
    if (browserAlive) {
      // close-tab and crash-renderer: the browser is still up; read through a new tab, as the app's next tab would.
      const reader = keeper ?? (await driver.context.newPage());
      await reader.goto(origin);
      await reader.waitForFunction(() => window.probeReady === true);
      record.after = await reader.evaluate(() => window.probe.read("rec"));
      record.readVia = "new tab in the same browser";
    }
  } catch (error) {
    record.failed = String(error?.stack ?? error);
  } finally {
    await driver.close();
  }
  if (!record.failed && !record.after) {
    // Relaunch the same way the run launched, so only the interruption differs.
    let reader;
    try {
      reader = driver.kind === "raw-cdp" ? await rawChromium(dir) : await openPlaywright(name, dir);
      record.after = await reader.ev('window.probe.read("rec")');
      record.readVia = `relaunched browser on the same profile (${reader.kind})`;
    } catch (error) {
      record.failed = `reading after the interruption failed: ${String(error?.stack ?? error?.message ?? error)}`;
    } finally {
      await reader?.close();
    }
  }
  rmSync(dir, { recursive: true, force: true });
  if (ballast) rmSync(ballast, { force: true });
  if (record.failed) return record;
  record.capturedMs = record.interruptWall - record.started.startWall;
  record.savedThroughMs = record.after.index ? record.after.index.savedThroughMs : null;
  record.lossMs = record.capturedMs - (record.savedThroughMs ?? 0);
  record.survival = survival(record.after);
  return record;
}

function survival(after) {
  if (!after?.indexReadable || !after.index) return after?.chunkRows ? "chunks without index" : "neither index nor chunks";
  if (!after.chunkRows) return "index, no chunks";
  const complete = after.index.state?.startsWith("stopped:") && after.index.chunks === after.chunkRows && after.readableChunks === after.chunkRows;
  return complete ? "index + all chunks" : "index + some chunks";
}

const versions = {
  image: IMAGE,
  playwright: require("playwright/package.json").version,
  os: readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="(.*)"/)?.[1],
  kernel: readFileSync("/proc/version", "utf8").trim(),
  display: "Xvfb (headed browsers), no window manager",
};
const capabilities = {};

for (const name of browsers) {
  const dir = mkdtempSync(resolve(tmpdir(), `v1-${name}-caps-`));
  let driver;
  try {
    driver = await openPlaywright(name, dir);
    const caps = await driver.ev("window.probe.capabilities()");
    caps.browserVersion = driver.version;
    capabilities[name] = caps;
  } catch (error) {
    capabilities[name] = { error: String(error) };
  } finally {
    await driver?.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // Delivery and commits while hidden, outside the kill cases.
  if (name === "chromium" && capabilities[name].mediaRecorder) {
    const hiddenDir = mkdtempSync(resolve(tmpdir(), "v1-chromium-hidden-"));
    const raw = await rawChromium(hiddenDir);
    try {
      await raw.ev(START);
      await sleep(2000);
      const how = await raw.hide();
      await sleep(10000);
      const snap = await raw.ev("window.probe.snapshot()");
      capabilities[name].hidden = {
        how,
        hiddenForMs: 10000,
        visibilityAtEnd: snap.visibility,
        deliveredWhileHidden: snap.deliveredWhileHidden,
        committedTotal: snap.committed,
        hiddenDeliveries: snap.events.filter((e) => e.type === "dataavailable" && e.visibility === "hidden").map((e) => e.wall - snap.startWall),
      };
    } finally {
      await raw.close();
      rmSync(hiddenDir, { recursive: true, force: true });
    }
  }
  // Does CDP's freeze request actually stop delivery on a recording page?
  if (name === "chromium" && capabilities[name].mediaRecorder) {
    const freezeDir = mkdtempSync(resolve(tmpdir(), "v1-chromium-freeze-"));
    const driver = await openPlaywright(name, freezeDir);
    try {
      await driver.ev(START);
      await sleep(2000);
      const cdp = await driver.context.newCDPSession(driver.page);
      const frozenAt = Date.now();
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      await sleep(5000);
      const resumedAt = Date.now();
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      await sleep(300);
      const snap = await driver.ev("window.probe.snapshot()");
      capabilities[name].freeze = {
        request: "CDP Page.setWebLifecycleState frozen for 5000 ms, then active",
        freezeEventFired: snap.events.some((e) => e.type === "freeze"),
        resumeEventFired: snap.events.some((e) => e.type === "resume"),
        deliveriesWhileFrozen: snap.events.filter((e) => e.type === "dataavailable" && e.wall > frozenAt && e.wall < resumedAt).length,
      };
    } finally {
      await driver.close();
      rmSync(freezeDir, { recursive: true, force: true });
    }
  }
  if (name !== "chromium" && capabilities[name].mediaRecorder) {
    capabilities[name].hidden = { how: null, note: "not measured: this runner cannot hide a tab for this engine (see hidden-then-kill)" };
  }
}
writeFileSync(resolve(out, "capabilities.json"), JSON.stringify({ versions, capabilities }, null, 2));
console.log(JSON.stringify({ versions, capabilities }, null, 2));

const resultsFile = resolve(out, "results.jsonl");
for (const name of browsers) {
  for (const kase of cases) {
    if (!capabilities[name]?.mediaRecorder) {
      appendFileSync(resultsFile, JSON.stringify({ browser: name, case: kase, skipped: "MediaRecorder is not exposed by this engine build" }) + "\n");
      continue;
    }
    for (let run = 1; run <= runsPerCell; run++) {
      const line = await runOnce(name, kase, run);
      const said = line.skipped ? `skipped: ${line.skipped}` : line.failed ? `FAILED: ${line.failed.split("\n")[0]}` : `captured ${line.capturedMs} ms, saved ${line.savedThroughMs} ms, loss ${line.lossMs} ms, ${line.survival}`;
      console.log(`${name} ${kase} #${run}: ${said}`);
      appendFileSync(resultsFile, JSON.stringify(line) + "\n");
      if (line.skipped) break;
    }
  }
}
server.close();
const runs = readFileSync(resultsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const summary = summarize(runs, { versions, capabilities });
writeFileSync(resolve(out, "summary.md"), summary);
console.log(summary);
process.exit(0);

// ---------------------------------------------------------------- summary

function summarize(runs, caps) {
  const cells = new Map();
  for (const r of runs) {
    const key = `${r.browser}|${r.case}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const lines = ["| Browser | Case | n | Loss ms min / median / max | Raw loss ms | Survival rows |", "| --- | --- | --- | --- | --- | --- |"];
  for (const [key, rs] of cells) {
    const [browser, kase] = key.split("|");
    const measured = rs.filter((r) => typeof r.lossMs === "number");
    const failed = rs.filter((r) => r.failed);
    if (!measured.length) {
      const why = rs.find((r) => r.skipped)?.skipped ?? failed[0]?.failed.split("\n")[0] ?? "no runs";
      lines.push(`| ${browser} | ${kase} | 0 | not measured: ${why} | | |`);
      continue;
    }
    const loss = measured.map((r) => r.lossMs);
    const rows = {};
    for (const r of measured) rows[r.survival] = (rows[r.survival] ?? 0) + 1;
    const n = `${measured.length}${failed.length ? ` (+${failed.length} failed)` : ""}`;
    const survivalText = Object.entries(rows)
      .map(([k, v]) => `${k} ×${v}`)
      .join("; ");
    lines.push(`| ${browser} | ${kase} | ${n} | ${Math.min(...loss)} / ${median(loss)} / ${Math.max(...loss)} | ${loss.join(", ")} | ${survivalText} |`);
  }
  return `${lines.join("\n")}\n\nVersions: ${JSON.stringify(caps.versions)}\n`;
}
