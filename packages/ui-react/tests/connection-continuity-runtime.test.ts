import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import type { DraftListResponse, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Repeated connection drops in the mounted app (#1013, the #578 epic's T2):
// the whole app as a hosting shell composes it (ConnectionGate, AppShell,
// ChatPage) in real Chrome against the real host. A drop is real on both
// sides: the browser goes offline (`context.setOffline`, so `navigator.onLine`
// and the `offline`/`online` events are Chromium's own) and the host's
// listener stops with every socket it holds, so the WebSocket closes and the
// connectivity probe fails until it listens again. An upload in flight fails
// the way a dropped network fails it. Nothing is mocked in the page.
//
// The scene is everything a drop may disturb: a long transcript scrolled
// away from both ends, a turn still running in it with a follow-up the host
// queued (#1002's pending pill), another running session drawn as a tracker
// (#950), and a draft the host keeps (#951) holding words, an image and a
// track whose upload is pending. Across ten drop/reconnect cycles at 320px
// and 1280px, each in one fixed theme, the test measures what the reader and
// writer would notice, in the offline state and again after recovery. Theme
// layout/interaction parity belongs to docs/process/theme-parity.md.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Connection-continuity runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING connection-continuity runtime proof: no Chrome; drop/reconnect continuity is unverified locally.");

// The DOM declaration omits Bun's native socket headers overload.
const HeaderWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
const repo = resolve(import.meta.dir, "../../..");
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let port = 0;
let origin = "";
let sequence = 0;
let diagnosticSequence = 0;
// One deliberately overlapped read, sampled at the original terminal and
// delivered after its queued successor. Later reads use ordinary fresh history.
type LateHistory = { sessionId: string; mode: "stale" | "fresh"; promise: Promise<void>; release(): void;
  entered: Promise<void>; start(): void; reads: number; released: boolean;
  snapshot?: SessionHistoryMessage[]; capturedAt?: number };
let lateHistory: LateHistory | undefined;

const transcripts = new Map<string, SessionHistoryMessage[]>();
const titles = new Map<string, string>();
/** Held turns, by prompt. */
const gates = new Map<string, () => void>();
const advance = new Map<string, () => void>();
const missed = new Map<string, () => void>();
// Bounded fixture-only evidence. Record without changing delivery or awaiting it.
const lifecycle: Array<{ at: number; stage: string; detail: unknown }> = [];
const observability = createRecordingObservability();
function recordLifecycle(stage: string, detail: unknown) {
  lifecycle.push({ at: Date.now(), stage, detail });
  if (lifecycle.length > 256) lifecycle.shift();
}
function describeFrame(value: string | Buffer) {
  try {
    const frame = JSON.parse(String(value));
    return { type: frame.type, sessionId: frame.sessionId, turnId: frame.turnId, requestId: frame.requestId,
      status: frame.status, outcome: frame.outcome, code: frame.code, message: frame.message,
      history: frame.messages?.slice(-4).map((message: SessionHistoryMessage) => ({ role: message.role, content: message.content.slice(-240) })),
      text: frame.text?.slice(-240), followUps: frame.followUps, started: frame.started, dropped: frame.dropped };
  } catch { return { type: "unreadable" }; }
}
const historyWaiters = new Map<string, { promise: Promise<void>; release(): void; reads: number; mode?: "empty" | "failed"; holdWhile?: () => boolean }>();

/** A long answer, so the transcript scrolls at every width. */
const LOG = Array.from({ length: 40 }, (_, i) => `Day ${i + 1}: the wax held, and the crew rowed on.`).join("\n\n");

/** A 64×64 PNG, so the composer's decoder takes it (32px is its floor). */
function png(rgb: [number, number, number]): Buffer {
  const size = 64;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set(rgb, y * (size * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const SAIL = png([200, 120, 40]);
const TRACK_NAME = "ithaca-to-pylos-coastal-route-day-3.geojson";
const TRACK = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Ithaca to Pylos" }, geometry: { type: "LineString", coordinates: [[20.71, 38.37], [20.95, 38.1], [21.3, 37.6], [21.69, 37.03]] } }] }));

/** The scripted backend: a `Hold:` turn streams a long opening and waits; anything else is noted. */
function scriptedBackend(): AgentBackend {
  return {
    id: "continuity-scripted",
    capabilities: { resume: true, permissions: false, thinking: false, attachments: true, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "continuity-scripted", label: "Local fixture" }],
    listSessions: async () => [...transcripts.keys()].map((id, i) => ({ id, title: titles.get(id) ?? "Odysseus", createdAt: 1 + i, lastActiveAt: Date.now(), totalCostUsd: 0, numTurns: 1 })),
    getHistory: async (sessionId) => {
      if (lateHistory?.sessionId === sessionId && !lateHistory.released && lateHistory.reads === 0) {
        const held = lateHistory;
        held.reads++;
        held.start();
        recordLifecycle("late-history-read-pending", { sessionId, reads: held.reads });
        await held.promise;
        if (!held.snapshot) throw new Error("Late-history control released without its terminal snapshot");
        const returned = held.mode === "fresh" ? transcripts.get(sessionId) ?? [] : held.snapshot;
        recordLifecycle("late-history-return", { sessionId, mode: held.mode, messages: returned.length, tail: returned.at(-1)?.content.slice(-200) });
        return structuredClone(returned);
      }
      const waiting = historyWaiters.get(sessionId);
      if (waiting && (!waiting.holdWhile || waiting.holdWhile())) {
        waiting.reads++; await waiting.promise;
        if (waiting.mode === "failed") throw new Error("History temporarily unavailable");
        if (waiting.mode === "empty") return [];
      }
      return structuredClone(transcripts.get(sessionId) ?? []);
    },
    async startTurn({ prompt: contextPrompt, bridge, sessionId: resumed, signal, attachments }) {
      // Route the fixture command independently of appended host budget context.
      const prompt = contextPrompt.split("\n", 1)[0]!;
      recordLifecycle("backend-start", { prompt, resumed });
      const emit: typeof bridge.emit = frame => {
        recordLifecycle("backend-emit", describeFrame(JSON.stringify(frame)));
        bridge.emit(frame);
      };
      const sessionId = resumed ?? `odysseus-continuity-${++sequence}`;
      const title = prompt.replace(/^[^:]*:\s*/, "").split(" (")[0]!;
      if (!titles.has(sessionId)) titles.set(sessionId, title);
      emit({ type: "session_info", sessionId, isNew: !resumed });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: prompt, toolCalls: [], ...(attachments?.length ? { attachmentCount: attachments.length } : {}) });
      if (prompt.startsWith("Hold:")) {
        const opening = `Setting out: ${title}. ${LOG}\n\n`;
        const partial: SessionHistoryMessage = { role: "assistant", content: opening, toolCalls: [] };
        transcript.push(partial);
        emit({ type: "text_delta", sessionId, text: opening });
        await new Promise<void>((release) => {
          gates.set(prompt, release);
          missed.set(prompt, () => {
            partial.content += "Missed tide. ";
            emit({ type: "text_delta", sessionId, text: "Missed tide. " });
          });
          advance.set(prompt, () => {
            partial.content += "Rowing again. ";
            emit({ type: "text_delta", sessionId, text: "Rowing again. " });
          });
        });
        if (signal.aborted) return;
        const end = `Landed: ${title}.`;
        partial.content += end;
        emit({ type: "text_delta", sessionId, text: end });
      } else {
        transcript.push({ role: "assistant", content: `Noted: ${title}.`, toolCalls: [] });
        emit({ type: "text_delta", sessionId, text: `Noted: ${title}.` });
      }
      emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
      if (lateHistory?.sessionId === sessionId) {
        if (prompt.startsWith("Hold: Sail past the Sirens")) {
          lateHistory.snapshot = structuredClone(transcript);
          lateHistory.capturedAt = Date.now();
          recordLifecycle("late-history-captured-original-terminal", { sessionId, messages: lateHistory.snapshot.length,
            tail: lateHistory.snapshot.at(-1)?.content.slice(-200), queue: app!.wsHost.followUpQueueFrame(sessionId) });
        } else if (prompt.startsWith("Then bind me to the mast")) {
          recordLifecycle("late-history-release-after-queued-result", { sessionId, messages: transcript.length,
            tail: transcript.at(-1)?.content.slice(-200), queue: app!.wsHost.followUpQueueFrame(sessionId) });
          lateHistory.released = true;
          lateHistory.release();
        }
      }
    },
  };
}

let backend: AgentBackend | undefined;
let config: ReturnType<typeof resolveServerConfig> | undefined;

function listen() {
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app!.fetch, websocket: app!.websocket });
  port = server.port!;
  origin = `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts", "--for", "ui-react,ui-server,core"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Connection-continuity fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-continuity-"));
  const brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:{entry:"client.js",chunk:"[name]-[hash].js"},splitting:true}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/connection-continuity-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Connection-continuity client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  backend = scriptedBackend();
  config = resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0", MAX_CONCURRENT_SESSIONS: "12" });
  app = await createApp({ config, staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability, turnTimeoutMs: 600_000 });
  const originalSend = app.wsHost.sendToClients;
  app.wsHost.sendToClients = function(frame) {
    recordLifecycle("host-broadcast", describeFrame(JSON.stringify(frame)));
    return originalSend.call(this, frame);
  };
  listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 240_000);

afterEach(() => {
  lateHistory?.release();
  lateHistory = undefined;
  lifecycle.length = 0;
  observability.reset();
  for (const release of gates.values()) release();
  gates.clear();
  advance.clear();
  missed.clear();
  for (const waiting of historyWaiters.values()) waiting.release();
  historyWaiters.clear();
});

afterAll(async () => {
  console.log("[measure] continuity waits", JSON.stringify(waitMetrics));
  for (const release of gates.values()) release();
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Probe = {
  connected(): boolean;
  received(type: string, sessionId: string): number;
  replayComplete(sessionId: string): boolean;
  wsStatus(): string;
  vpnStatus(): string;
  draftsSupported(): boolean | null;
  activeSessionId(): string | null;
  streaming(sessionId: string): boolean;
  views(): Array<{ sessionId: string; state: string }>;
  draft(): { text: string; images: number; sessionId: string | null };
};
const probe = <T,>(page: Page, fn: (p: Probe) => T) => page.evaluate(`(${fn.toString()})(window.__continuity)`) as Promise<T>;
async function until(page: Page, predicate: string, timeout = 20_000) {
  try {
    await page.waitForFunction(`(() => { const p = window.__continuity; return ${predicate}; })()`, undefined, { timeout });
  } catch (error) {
    console.error(`never held: ${predicate}`, JSON.stringify(await page.evaluate("({ ws: window.__continuity?.wsStatus(), vpn: window.__continuity?.vpnStatus(), active: window.__continuity?.activeSessionId(), draft: window.__continuity?.draft() })").catch(() => null)));
    throw error;
  }
}

async function hostDrafts(): Promise<DraftListResponse["drafts"]> {
  const res = await fetch(`${origin}/api/drafts`, { headers: { origin } });
  if (!res.ok) throw new Error(`GET /api/drafts ${res.status}`);
  return ((await res.json()) as DraftListResponse).drafts;
}
async function hostUntil(predicate: (drafts: DraftListResponse["drafts"]) => boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const drafts = await hostDrafts();
    if (predicate(drafts)) return drafts;
    if (Date.now() > end) throw new Error(`host drafts never matched: ${JSON.stringify(drafts)}`);
    await hostPoll(100);
  }
}

/**
 * Runs in the page before the app: every composition and focus event on a
 * textarea, in order, and whether the test itself asked for the commit that
 * ended a composition. Recorded, never acted on.
 */
function recorder() {
  const events: Array<{ type: string; data?: string | null; asked?: boolean }> = [];
  const w = window as unknown as { __events: typeof events; __commitAsked: boolean };
  w.__events = events;
  w.__commitAsked = false;
  for (const type of ["compositionstart", "compositionend", "blur", "focusout"]) {
    document.addEventListener(type, (event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      events.push({ type, data: (event as CompositionEvent).data ?? null, asked: w.__commitAsked });
    }, true);
  }
}

type Cell = { name: string; theme: "dark" | "light"; width: number; height: number };
// Responsive recovery paths are independent; theme copies are covered centrally.
const cells: Cell[] = [
  { name: "320 phone, dark", theme: "dark", width: 320, height: 640 },
  { name: "1280 desktop, light", theme: "light", width: 1280, height: 800 },
];
const wide = (cell: Cell) => cell.width >= 1280;

/** The network between one browser context and the host. */
type Net = {
  /** Upload requests the host has not seen yet, held where the network would hold them. */
  held: Route[];
  holdTracks: boolean;
  uploads: number;
  /** Every frame the page sent, by type. */
  sent: string[];
  holdQueues: boolean;
  queues: Array<() => void>;
  trace: Array<{ at: number; stage: string; frame: ReturnType<typeof describeFrame> }>;
};
type Scene = { context: BrowserContext; page: Page; net: Net; A: string; B: string; draft: string };

/** Drawn trackers, as session ids: the row's strip below 1280, the pane's Working group from 1280. */
function drawn(cell: Cell, page: Page) {
  const sel = wide(cell) ? "section[data-sessions-pane] [data-working-row]" : '[data-row-half="left"] [data-session-strip] [data-session]';
  return page.locator(sel).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.session!));
}
const composer = (page: Page) => page.locator("textarea[data-composer]");
const newChat = async (cell: Cell, page: Page) => {
  await page.getByRole("button", { name: wide(cell) ? "New conversation" : "New chat", exact: true }).first().click();
  await until(page, "p.activeSessionId() === null");
};
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.waitForFunction(() => {
    const send = document.querySelector('[role="button"][aria-label="Send"]');
    // Streaming keeps Enter available while its visible action is Stop.
    return (send !== null && send.getAttribute("aria-disabled") !== "true")
      || document.querySelector('[role="button"][aria-label="Stop generating"]') !== null;
  });
  await composer(page).press("Enter");
}

/**
 * Called after each operation's own acknowledgement (history delivery, saved
 * revision, rendered text or native IME event). Finish finite entrances and
 * layout before measuring; this is not a negative-observation window.
 */
const waitMetrics = { renderCalls: 0, renderMs: 0, observationCalls: 0, observationMs: 0, retainedFrameCalls: 0, retainedFrameMs: 0, pollCalls: 0, pollMs: 0 };
async function finishRender(page: Page) {
  const started = performance.now();
  waitMetrics.renderCalls++;
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise<void>(done => requestAnimationFrame(() => done()));
    const geometry = () => [...document.querySelectorAll("textarea[data-composer], [data-reading-column], [data-pill], [data-track-chip]")].map(el => {
      const rect = el.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height, el.parentElement?.scrollTop];
    });
    let previous = "";
    let stable = 0;
    while (stable < 2) {
      // Infinite activity indicators are intentionally ongoing. Finite
      // entrances/transitions must finish, including ones created on a frame.
      const animations = document.getAnimations().filter(animation =>
        animation.playState !== "finished" && animation.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
      await frame();
      const current = JSON.stringify(geometry());
      stable = current === previous && animations.length === 0 ? stable + 1 : 0;
      previous = current;
    }
  });
  waitMetrics.renderMs += performance.now() - started;
}

/**
 * A bounded native observation window for delayed focus/save/ghost reactions
 * and unsolicited sends after recovery/IME changes. These are negative temporal
 * assertions: stable geometry alone can precede the forbidden late effect.
 * Keep the original 500ms budget until those tasks have causal completion
 * signals. Native history/queue/upload acknowledgements remain separate.
 */
async function settle(page: Page) {
  const started = performance.now();
  waitMetrics.observationCalls++;
  await page.waitForTimeout(500);
  waitMetrics.observationMs += performance.now() - started;
  // Preserve the original post-window frame observation at these sites.
  const framesStarted = performance.now();
  waitMetrics.retainedFrameCalls++;
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  waitMetrics.retainedFrameMs += performance.now() - framesStarted;
}

async function scene(cell: Cell, prepare = prepareScene): Promise<Scene> {
  const context = await browser!.newContext({ viewport: { width: cell.width, height: cell.height }, reducedMotion: "reduce", offline: true });
  try {
    return await prepare(context, cell);
  } catch (error) {
    // Callers cannot enter their finally until scene preparation returns.
    await context.close();
    throw error;
  }
}

async function prepareScene(context: BrowserContext, cell: Cell): Promise<Scene> {
  const tag = `(${cell.name})`;
  const net: Net = { held: [], holdTracks: true, uploads: 0, sent: [], holdQueues: false, queues: [], trace: [] };
  // Keep the real browser offline apart from this one local host.
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.route("**/api/track-upload", (route) => {
    net.uploads++;
    if (net.holdTracks) net.held.push(route);
    else void route.continue();
  });
  // Forward the real socket, with an explicit network delay for queue frames.
  // This lets hello/history paint before an authoritative queue arrives.
  await context.routeWebSocket(`${origin.replace("http", "ws")}/**`, (socket) => {
    const host = socket.connectToServer();
    host.onMessage((message) => {
      const record = (stage: string) => {
        net.trace.push({ at: Date.now(), stage, frame: describeFrame(message) });
        if (net.trace.length > 256) net.trace.shift();
      };
      record("host-received");
      const send = () => { record("client-forwarded"); socket.send(message); };
      if (net.holdQueues && typeof message === "string" && JSON.parse(message).type === "session_queue") net.queues.push(send);
      else send();
    });
  });
  await context.addInitScript((theme) => localStorage.setItem("odysseus-continuity:brain-theme", theme), cell.theme);
  await context.addInitScript(recorder);
  const page = await nativeOnlinePage(context);
  page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => {
    try { net.sent.push(String(JSON.parse(String(payload)).type)); } catch { net.sent.push("unreadable"); }
  }));
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.goto(origin);
  await until(page, "p?.connected() && p.draftsSupported() === true");
  await finishRender(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme), "the cell's theme is the one drawn").toBe(cell.theme);

  // B runs out of view: a tracker where the width draws it (#950).
  await send(page, `Hold: Row through Scylla's strait ${tag}`);
  await until(page, "p.activeSessionId() !== null && p.streaming(p.activeSessionId())");
  const B = (await probe(page, (p) => p.activeSessionId()))!;
  await page.getByText("Setting out: Row through Scylla's strait").first().waitFor();
  await finishRender(page);
  await newChat(cell, page);

  // A runs in view with a long transcript, and a follow-up waits as a pill (#1002).
  await page.locator('input[type="file"][accept="image/*"]:not([capture])').setInputFiles({ name: "sent-sail.png", mimeType: "image/png", buffer: SAIL });
  await until(page, "p.draft().images === 1");
  await send(page, `Hold: Sail past the Sirens ${tag}`);
  await until(page, "p.activeSessionId() !== null && p.streaming(p.activeSessionId())");
  const A = (await probe(page, (p) => p.activeSessionId()))!;
  await page.getByText("Setting out: Sail past the Sirens").first().waitFor();
  await send(page, `Then bind me to the mast ${tag}`);
  await page.locator('[data-row-half="right"] [data-pill]').first().waitFor();
  expect(await drawn(cell, page), "B is tracked").toEqual([B]);

  // A's draft: words, an image and a track whose upload has not landed (#951).
  const draft = `Steer west of Scylla toward Ithaca ${tag}`;
  await composer(page).fill(draft);
  await page.locator('input[type="file"][accept="image/*"]:not([capture])').setInputFiles({ name: "sail.png", mimeType: "image/png", buffer: SAIL });
  await until(page, "p.draft().images === 1");
  await page.locator('input[type="file"][accept*=".gpx"]').setInputFiles({ name: TRACK_NAME, mimeType: "application/geo+json", buffer: TRACK });
  await page.waitForFunction(() => /uploading/.test(document.querySelector("[data-track-chip]")?.getAttribute("aria-label") ?? ""));
  await page.locator('[data-draft-save="saved"]').waitFor();
  await hostUntil((d) => d.some((x) => x.sessionId === A && x.attachmentCount === 1 && x.preview === draft));

  // The reader scrolls up, away from both ends, with the mouse wheel.
  const box = await page.locator("[data-reading-column]").evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  const scrollBefore = await page.locator("[data-reading-column]").evaluate(el => el.parentElement!.scrollTop);
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(before => document.querySelector("[data-reading-column]")!.parentElement!.scrollTop < before, scrollBefore);
  await settle(page);
  const scroll = await page.locator("[data-reading-column]").evaluate((el) => {
    const s = el.parentElement!;
    return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight };
  });
  expect(scroll.top, "scrolled away from the top").toBeGreaterThan(100);
  expect(scroll.max - scroll.top, "and from the bottom").toBeGreaterThan(100);
  await composer(page).focus();
  return { context, page, net, A, B, draft };
}

/**
 * Playwright skips the initial offline:false protocol update. Start this
 * context offline, then change its native state after a page exists, before
 * the app loads. A loopback-only namespace otherwise starts navigator offline.
 * Egress still belongs to the namespace and origin route; this changes no
 * navigator property and leaves subsequent native offline/online events live.
 */
async function nativeOnlinePage(context: BrowserContext): Promise<Page> {
  await context.addInitScript(() => {
    const events: Array<{ type: string; online: boolean; trusted: boolean }> = [];
    Object.assign(window, { __nativeConnectivity: events });
    for (const type of ["offline", "online"]) window.addEventListener(type, event => {
      events.push({ type: event.type, online: navigator.onLine, trusted: event.isTrusted });
      if (events.length > 32) events.shift();
    });
  });
  const page = await context.newPage();
  expect(await page.evaluate(() => navigator.onLine), "native context starts offline").toBe(false);
  await context.setOffline(false);
  expect(await page.evaluate(() => navigator.onLine), "native initial upload state is online").toBe(true);
  return page;
}

const connectivity = (page: Page) => page.evaluate(() => ({
  online: navigator.onLine,
  events: (window as unknown as { __nativeConnectivity: Array<{ type: string; online: boolean; trusted: boolean }> }).__nativeConnectivity,
}));

/** What the reader and the writer would notice, measured against the marks taken at the baseline. */
type Measure = {
  fieldTop: number;
  sameField: boolean;
  firstTop: number | null;
  scrollTop: number;
  focused: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  replaced: number;
  previews: string[];
  track: string;
  pills: string[];
  transcriptPreviews: string[];
  replacedImages: number;
  replacedPills: number;
  removedPills: number;
};
async function mark(page: Page) {
  await page.evaluate(() => {
    const field = document.querySelector("textarea[data-composer]")!;
    const column = document.querySelector("[data-reading-column]")!;
    const top = column.parentElement!.getBoundingClientRect().top;
    const nodes = [...column.children];
    const first = nodes.find((n) => n.getBoundingClientRect().bottom > top + 1)!;
    const images = [...column.querySelectorAll("img")];
    const pills = [...document.querySelectorAll('[data-row-half="right"] [data-pill]')];
    const marks = { field, nodes, first, images, pills, removedPills: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const removed of record.removedNodes) {
        marks.removedPills += pills.filter((pill) => removed === pill || removed.contains(pill)).length;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Object.assign(window, { __marks: marks });
    // From here on, every composition and focus event is the drops' doing.
    (window as unknown as { __events: unknown[] }).__events.length = 0;
  });
}
function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const marks = (window as unknown as { __marks: { field: HTMLTextAreaElement; nodes: Element[]; first: Element; images: HTMLImageElement[]; pills: Element[]; removedPills: number } }).__marks;
    const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
    const column = document.querySelector("[data-reading-column]")!;
    return {
      fieldTop: field.getBoundingClientRect().top,
      sameField: field === marks.field,
      firstTop: marks.first.isConnected ? marks.first.getBoundingClientRect().top : null,
      scrollTop: column.parentElement!.scrollTop,
      focused: document.activeElement === marks.field,
      value: field.value,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
      replaced: marks.nodes.filter((n) => !n.isConnected).length,
      previews: [...document.querySelectorAll("[data-composer] img")].map((img) => (img as HTMLImageElement).src),
      track: document.querySelector("[data-track-chip]")?.getAttribute("aria-label") ?? "",
      pills: [...document.querySelectorAll('[data-row-half="right"] [data-pill]')].map((pill) => pill.textContent ?? ""),
      transcriptPreviews: [...column.querySelectorAll("img")].map((img) => img.src),
      replacedImages: marks.images.filter((img) => !img.isConnected).length,
      replacedPills: marks.pills.filter((pill) => !pill.isConnected).length,
      removedPills: marks.removedPills,
    };
  });
}

/** A drop as a phone sees one: the host's sockets and the in-flight upload cut, the browser offline. */
async function drop(s: Pick<Scene, "net" | "context" | "page">, preparation: "scene" | "held-snapshot" = "scene") {
  // The upload in flight fails first, before the page has seen anything else
  // of the drop: the order that cannot hide a failure behind a pause.
  const uploading = s.net.held.splice(0);
  for (const route of uploading) await route.abort("connectionreset").catch(() => {});
  if (uploading.length) await s.page.waitForFunction(() => !/uploading/.test(document.querySelector("[data-track-chip]")?.getAttribute("aria-label") ?? ""));
  server!.stop(true);
  const beforeOffline = await connectivity(s.page);
  await s.context.setOffline(true);
  await until(s.page, "p.wsStatus() !== 'connected' && p.vpnStatus() === 'unreachable'");
  await s.page.locator('[role="status"]', { hasText: "Connection lost" }).waitFor();
  const offline = await connectivity(s.page);
  expect(offline.online, "native drop reports offline").toBe(false);
  expect(offline.events, "native drop dispatches one trusted offline event").toEqual([
    ...beforeOffline.events, { type: "offline", online: false, trusted: true },
  ].slice(-32));
  // Scenes measure the offline state itself. Snapshots have no held uploads
  // or offline geometry oracle; their draft save is acknowledged on recovery.
  if (preparation === "scene") await settle(s.page);
  else await finishRender(s.page);
}

/** The network and the host come back; the app finds them on its own. */
async function recover(s: Pick<Scene, "context" | "page"> & Partial<Pick<Scene, "A">>, preparation: "scene" | "held-snapshot" = "scene") {
  const statusBefore = s.A ? await probe(s.page, p => p.received("status", p.activeSessionId()!)) : 0;
  listen();
  const beforeOnline = await connectivity(s.page);
  await s.context.setOffline(false);
  await until(s.page, "p.connected() && p.vpnStatus() === 'connected'");
  await s.page.locator('[role="status"]', { hasText: "Connection lost" }).waitFor({ state: "detached" });
  const online = await connectivity(s.page);
  expect(online.online, "native recovery reports online").toBe(true);
  expect(online.events, "native recovery dispatches one trusted online event").toEqual([
    ...beforeOnline.events, { type: "online", online: true, trusted: true },
  ].slice(-32));
  // Connected/hello precedes asynchronous history. Scenes wait for the actual
  // replay; snapshot-race cases deliberately hold history and await their own
  // release/status barrier instead.
  if (s.A && !historyWaiters.has(s.A)) await until(s.page,
    `p.received("status", ${JSON.stringify(s.A)}) > ${statusBefore} && p.replayComplete(${JSON.stringify(s.A)})`);
  // The snapshot caller acknowledges its intentionally held reads and current
  // saved draft before selection; scenes retain their negative recovery window.
  if (preparation === "scene") await settle(s.page);
}

/**
 * Node identity first: a replaced transcript also moves the field (the
 * replayed answer is no longer streaming), and that must not mask it.
 */
function same(label: string, now: Measure, base: Measure) {
  expect(now.removedPills, `${label}: no pending pill was removed during recovery`).toBe(0);
  expect(now.replacedPills, `${label}: pending pills keep their original nodes`).toBe(0);
  expect(now.replacedImages, `${label}: sent image nodes stay mounted`).toBe(0);
  expect(now.transcriptPreviews, `${label}: the transcript keeps its sent image representation`).toEqual(base.transcriptPreviews);
  expect(now.replaced, `${label}: no transcript message node replaced`).toBe(0);
  expect(Math.abs(now.fieldTop - base.fieldTop), `${label}: the composer field's top`).toBeLessThanOrEqual(1);
  expect(now.firstTop, `${label}: the first visible message is still the same node`).not.toBeNull();
  expect(Math.abs(now.firstTop! - base.firstTop!), `${label}: the first visible message's top`).toBeLessThanOrEqual(1);
  expect(now.scrollTop, `${label}: the transcript's scrollTop`).toBe(base.scrollTop);
  expect(now.sameField, `${label}: the textarea is the same node`).toBe(true);
  expect(now.focused, `${label}: the textarea keeps focus`).toBe(true);
  expect(now.value, `${label}: the textarea's value`).toBe(base.value);
  expect([now.selectionStart, now.selectionEnd], `${label}: the selection`).toEqual([base.selectionStart, base.selectionEnd]);
  expect(now.previews, `${label}: the attachment keeps its object URL`).toEqual(base.previews);
  expect(now.pills, `${label}: the pending follow-up keeps its text and state`).toEqual(base.pills);
}

/** The restored socket must deliver into the retained answer, then drain the queue. */
async function finishRecoveredTurn(s: Scene, cell: Cell) {
  try {
    const prompt = `Hold: Sail past the Sirens (${cell.name})`;
    const release = gates.get(prompt);
    expect(release, "the real host still holds A's turn").toBeDefined();
    advance.get(prompt)!();
    await s.page.waitForFunction(() => {
      const marks = (window as unknown as { __marks: { nodes: Element[] } }).__marks;
      return marks.nodes.at(-1)?.textContent?.includes("Rowing again.");
    });
    expect(await probe(s.page, (p) => p.streaming(p.activeSessionId()!)), "the resumed delta arrived before the terminal result").toBe(true);
    release!();
    gates.delete(prompt);
    await s.page.waitForFunction(() => {
      const marks = (window as unknown as { __marks: { nodes: Element[] } }).__marks;
      return marks.nodes.at(-1)?.textContent?.includes("Landed: Sail past the Sirens.");
    });
    await until(s.page, `!p.streaming(${JSON.stringify(s.A)})`);
    await s.page.waitForFunction(() => document.querySelector("[data-reading-column]")?.textContent?.includes("Noted: Then bind me to the mast."));
    if (lateHistory) {
      await s.page.waitForFunction((sessionId) => {
        const p = (window as unknown as { __continuity: { diagnostic(): {
          frames: Array<{ type: string; sessionId?: string; text?: string; status?: string }>;
          buffers: Record<string, { streaming: boolean; replay: boolean }>;
        } } }).__continuity.diagnostic();
        const frames = p.frames.filter(frame => frame.sessionId === sessionId);
        const noted = frames.findLastIndex(frame => frame.type === "text_delta" && frame.text?.includes("Noted: Then bind me to the mast."));
        const terminal = frames.findIndex((frame, index) => index > noted && frame.type === "result");
        const history = frames.findIndex((frame, index) => index > terminal && frame.type === "session_history");
        return noted >= 0 && terminal > noted && history > terminal &&
          frames.some((frame, index) => index > history && frame.type === "status" && frame.status === "idle") &&
          !p.buffers[sessionId]?.streaming && !p.buffers[sessionId]?.replay;
      }, s.A);
    }
    // Keep the original negative observation after the causal history/status
    // barrier, so an old React commit cannot masquerade as retained state.
    await settle(s.page);
    if (lateHistory) {
      const retained = await s.page.evaluate(sessionId => {
        const p = (window as unknown as { __continuity: { diagnostic(): {
          buffers: Record<string, { messages: Array<{ role: string; content: string }> }>;
        } } }).__continuity.diagnostic();
        return p.buffers[sessionId]!.messages.slice(-2);
      }, s.A);
      expect(retained.map(message => message.role), "the settled store keeps the queued exchange").toEqual(["user", "assistant"]);
      expect(retained[0]!.content).toContain("Then bind me to the mast");
      expect(retained[1]!.content).toBe("Noted: Then bind me to the mast.");
      expect(await s.page.evaluate(() => document.querySelector("[data-reading-column]")?.textContent?.includes("Noted: Then bind me to the mast.")),
        "the queued reply remains visible after the late history and terminal status settle").toBe(true);
    }
    expect(await s.page.evaluate(() => {
      const marks = (window as unknown as { __marks: { nodes: Element[] } }).__marks;
      const column = document.querySelector("[data-reading-column]")!;
      return marks.nodes.at(-1)?.isConnected && column.children[1] === marks.nodes.at(-1);
    }), "recovered text and the terminal replay kept the original answer node").toBe(true);
    expect(await s.page.locator('[data-row-half="right"] [data-pill]').count(), "the queued follow-up was taken").toBe(0);
  } catch (error) {
    const client = await s.page.evaluate(() => {
      const state = (window as unknown as { __continuity: { diagnostic(): unknown } }).__continuity;
      return { state: state.diagnostic(), column: document.querySelector("[data-reading-column]")?.textContent?.slice(-2000) };
    }).catch(failure => ({ diagnosticError: String(failure) }));
    const evidence = { capturedAt: Date.now(), cell, sessionId: s.A,
      lateHistory: lateHistory ? { mode: lateHistory.mode, reads: lateHistory.reads, released: lateHistory.released, capturedAt: lateHistory.capturedAt, snapshot: lateHistory.snapshot } : null,
      queue: app!.wsHost.followUpQueueFrame(s.A),
      slots: [...app!.wsHost.coordinator.running].map(turn => ({ sessionId: turn.sessionId, turnId: turn.turnId,
        cancelled: turn.cancelled, backendStarted: turn.backendStarted, queue: turn.queue.map(entry => ({ id: entry.followUpId, text: entry.text })) })),
      transcript: transcripts.get(s.A)?.slice(-4), lifecycle, transport: s.net.trace,
      logs: observability.logs.records().slice(-64), client };
    // A single large stderr line can interleave with the timeout report. Keep
    // complete JSON in the existing unit artifact glob, with a short log pointer.
    const name = `connection-continuity-${cell.width}-${++diagnosticSequence}-probe.json`;
    try {
      await mkdir(resolve(repo, "tmp"), { recursive: true });
      await writeFile(resolve(repo, "tmp", name), JSON.stringify(evidence, null, 2));
      console.error("QUEUED_FOLLOWUP_LIFECYCLE", JSON.stringify({ path: `tmp/${name}`, cell, sessionId: s.A,
        pending: evidence.queue.followUps.length, lifecycle: lifecycle.length, transport: s.net.trace.length }));
    } catch (captureError) {
      console.error("QUEUED_FOLLOWUP_LIFECYCLE capture failed", String(captureError));
    }
    throw error;
  }
}

describe.skipIf(!executablePath)("repeated connection drops in the mounted app", () => {
  for (const cell of cells) for (const mode of ["stale", "fresh"] as const) {
    test(`${cell.name}: a ${mode} late history read retains the settled queued reply`, async () => {
      const s = await scene(cell);
      let release!: () => void;
      let start!: () => void;
      const held: LateHistory = lateHistory = { sessionId: s.A, mode, reads: 0, released: false,
        promise: new Promise<void>(done => { release = done; }), release: () => release(),
        entered: new Promise<void>(done => { start = done; }), start: () => start() };
      try {
        await mark(s.page);
        await drop(s);
        s.net.holdTracks = false;
        // Reuse the fixture's held-history recovery path. The read is allowed
        // to overlap turn completion; the original ten-drop cases still await
        // their ordinary early replay-completion barrier.
        historyWaiters.set(s.A, { promise: held.promise, release: held.release, reads: held.reads, holdWhile: () => false });
        await recover(s);
        await held.entered;
        expect(held.reads, "exactly one reconnect read is held").toBe(1);
        await finishRecoveredTurn(s, cell);
        expect(held.released, "queued completion released the read").toBe(true);
        expect(lateHistory?.snapshot, "the old snapshot precedes the queued turn").toHaveLength(2);
        expect(transcripts.get(s.A), "the backend retains both completed turns").toHaveLength(4);
      } finally {
        held.release();
        historyWaiters.delete(s.A);
        await s.context.close();
      }
    }, 300_000);
  }
  test("failed native scene preparation closes its browser context", async () => {
    const existing = browser!.contexts();
    const failure = new Error("fixture native connectivity failure");
    let created: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      // Await native work before asserting; Bun's promise matcher can stall
      // the browser protocol while synchronously waiting (#1993, #1999).
      let observed: unknown;
      try {
        await scene(cells[0]!, async context => {
          created = context;
          page = await nativeOnlinePage(context);
          throw failure;
        });
      } catch (error) { observed = error; }
      expect(observed, "scene rethrows its original preparation failure").toBe(failure);
      expect(page, "the failure happened after real native page preparation").toBeDefined();
      expect(page!.isClosed(), "failed scene closes its page and observers").toBe(true);
      expect(browser!.contexts(), "failed scene owns no surviving browser context").toEqual(existing);
    } finally {
      await created?.close();
    }
  });

  test("render readiness waits for a finite entrance even when its initial geometry is quiet", async () => {
    const context = await browser!.newContext();
    try {
      await context.route("**/*", route => route.abort());
      const page = await context.newPage();
      await page.setContent('<textarea data-composer style="position:absolute;top:0">Ithaca</textarea>');
      await page.evaluate(() => {
        const field = document.querySelector("textarea")!;
        // A real compositor animation can keep the same geometry for several
        // frames before moving. Quiet frames cannot stand in for its finish.
        const animation = field.animate([
          { transform: "translateY(0)", offset: 0 },
          { transform: "translateY(0)", offset: 0.8 },
          { transform: "translateY(20px)", offset: 1 },
        ], { duration: 200, fill: "forwards" });
        Object.assign(window, { __entrance: animation });
      });
      await finishRender(page);
      expect(await page.evaluate(() => (window as unknown as { __entrance: Animation }).__entrance.playState),
        "FINITE_ANIMATION_FINISHED_BEFORE_GEOMETRY").toBe("finished");
      expect(await page.locator("textarea").evaluate(el => el.getBoundingClientRect().top)).toBe(20);
    } finally { await context.close(); }
  });

  for (const { mode, newer } of [{ mode: "empty", newer: true }, { mode: "failed", newer: true }, { mode: "failed", newer: false }] as const) test(`single running session: a captured ${mode} history snapshot cannot end ${newer ? "a newer" : "its quiet"} turn`, async () => {
    const context = await browser!.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: "reduce", offline: true });
    let release!: () => void;
    let peer: WebSocket | undefined;
    let sessionId = "";
    let page: Page | undefined;
    let appLoaded = false;
    const first = `Hold: Sail past the Sirens (snapshot ${mode})`;
    const second = `Hold: Then bind me to the mast (snapshot ${mode})`;
    try {
      await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(() => { Object.assign(window, { __observeContinuityPreparation: true }); });
      page = await nativeOnlinePage(context);
      const frames: Array<{ type: string; sessionId?: string; turnId?: string; status?: string; detail?: string }> = [];
      const net: Net = { held: [], holdTracks: false, uploads: 0, sent: [], holdQueues: false, queues: [], trace: [] };
      let socketUrl = "";
      page.on("websocket", (ws) => {
        socketUrl = ws.url();
        ws.on("framereceived", ({ payload }) => frames.push(JSON.parse(String(payload))));
        ws.on("framesent", ({ payload }) => net.sent.push(String(JSON.parse(String(payload)).type)));
      });
      page.on("dialog", (dialog) => void dialog.dismiss());
      await page.goto(origin);
      appLoaded = true;
      await until(page, "p?.connected() && p.draftsSupported() === true"); await finishRender(page);
      await send(page, first); await until(page, "p.activeSessionId() !== null && p.streaming(p.activeSessionId())");
      sessionId = (await probe(page, (p) => p.activeSessionId()))!;
      await page.getByText("Setting out: Sail past the Sirens").first().waitFor(); await finishRender(page);
      const oldTurn = frames.find((f) => f.type === "text_delta" && f.sessionId === sessionId)?.turnId;
      expect(oldTurn, "the original answer has a host-proven turn").toBeTruthy();
      const draft = "Steer toward Ithaca"; await composer(page).fill(draft); await composer(page).focus();
      const waiting = { promise: new Promise<void>((done) => { release = done; }), release: () => release(), reads: 0, mode, holdWhile: () => gates.has(first) };
      historyWaiters.set(sessionId, waiting);
      const sentBefore = net.sent.length; expect(net.sent).toContain("chat_message");
      await drop({ context, page, net }, "held-snapshot"); await recover({ context, page }, "held-snapshot");
      const readDeadline = Date.now() + 5_000;
      while (!waiting.reads && Date.now() < readDeadline) await hostPoll(10);
      expect(waiting.reads, "the real reconnect is awaiting history while the original turn runs").toBeGreaterThan(0);
      expect(gates.has(first)).toBe(true);
      let preparation: { socket: number; cursor: number; heldResumes: number } | undefined;
      {
        // The original captured snapshot and the current socket's initial
        // resume reads must all have entered the same held backend gate.
        // This is a strengthened setup acknowledgement, not a drain.
        await page.evaluate("window.__continuity.preparation.restoring()");
        await until(page, `p.preparation.recovered(${JSON.stringify(sessionId)}, ${JSON.stringify(draft)})`, 5_000);
        preparation = await page.evaluate((id) => (window as any).__continuity.preparation.checkpoint(id), sessionId);
        const heldDeadline = Date.now() + 5_000;
        while (waiting.reads < preparation!.heldResumes + 1 && Date.now() < heldDeadline) await hostPoll(10);
        expect(preparation!.heldResumes, "the reconnect sent an actual session resume").toBeGreaterThan(0);
        expect(waiting.reads, "the connect snapshot and every initial resume are held before old completion").toBe(preparation!.heldResumes + 1);
        await finishRender(page);
      }
      const beforeOldCompletion = frames.length;
      if (newer) { gates.get(first)!(); gates.delete(first); }
      if (newer) {
        await until(page, `!p.streaming(${JSON.stringify(sessionId)})`);
        // Result ends the UI stream before asynchronous host finalization. With
        // no queued request, this scoped idle is followed by synchronous slot
        // removal; the peer must start a new slot rather than mutate the old one.
        const oldCompleted = () => frames.slice(beforeOldCompletion).some((f) =>
          f.type === "status" && f.status === "idle" && f.sessionId === sessionId && f.turnId === oldTurn);
        const completionDeadline = Date.now() + 5_000;
        while (!oldCompleted() && Date.now() < completionDeadline) await hostPoll(10);
        expect(oldCompleted(), "the original host turn completes before the peer starts a new slot").toBe(true);
        // A different client starts a new slot after the captured turn ended.
        // Queued turns reuse the original slot, so its turnId mutates in place.
        peer = new HeaderWebSocket(socketUrl, { headers: { Origin: origin } });
        await new Promise<void>((done, reject) => { peer!.onopen = () => done(); peer!.onerror = reject; });
        peer.send(JSON.stringify({ type: "chat_message", sessionId, text: second }));
        await page.getByText("Setting out: Then bind me to the mast").first().waitFor();
        await until(page, `p.preparation.ready(${JSON.stringify(preparation)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(oldTurn)}, ${JSON.stringify(draft)})`, 5_000);
        await finishRender(page);
      }
      const activePrompt = newer ? second : first;
      expect(gates.has(activePrompt), "the actual host turn runs before history answers").toBe(true);
      await composer(page).focus();
      await page.evaluate(() => {
        const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
        field.setSelectionRange(6, 12);
        const answer = document.querySelector("[data-reading-column]")!.lastElementChild!;
        Object.assign(window, { __snapshotMarks: { field, answer } });
      });
      const currentTurn = frames.findLast((f) => f.type === "text_delta" && f.sessionId === sessionId)?.turnId;
      expect(currentTurn, "the running answer has a host-proven turn").toBeTruthy();
      if (newer) expect(currentTurn, "the successor has its own turn identity").not.toBe(oldTurn);
      const beforeStatus = frames.length; release(); historyWaiters.delete(sessionId);
      const statusDeadline = Date.now() + 5_000;
      while (!frames.slice(beforeStatus).some((f) => f.type === "status" && f.turnId === currentTurn && f.detail === "Session in progress") && Date.now() < statusDeadline) await hostPoll(10);
      expect(frames.slice(beforeStatus).some((f) => f.type === "status" && f.turnId === currentTurn && f.detail === "Session in progress"), "the snapshot reports the current turn after its asynchronous read").toBe(true);
      await settle(page);
      expect(await probe(page, (p) => p.streaming(p.activeSessionId()!)), newer ? "the delayed snapshot cannot end the newer answer" : "a quiet failed history read cannot end the actual running answer").toBe(true);
      expect(advance.has(activePrompt)).toBe(true); advance.get(activePrompt)!();
      await page.waitForFunction(() => (window as unknown as { __snapshotMarks: { answer: Element } }).__snapshotMarks.answer.textContent?.includes("Rowing again."));
      expect(await page.evaluate(() => {
        const { field, answer } = (window as unknown as { __snapshotMarks: { field: HTMLTextAreaElement; answer: Element } }).__snapshotMarks;
        return { sameAnswer: answer.isConnected && document.querySelector("[data-reading-column]")!.lastElementChild === answer,
          sameField: field === document.querySelector("textarea[data-composer]"), focused: document.activeElement === field,
          value: field.value, selection: [field.selectionStart, field.selectionEnd] };
      })).toEqual({ sameAnswer: true, sameField: true, focused: true, value: draft, selection: [6, 12] });
      expect(net.sent.slice(sentBefore).filter((t) => t === "chat_message"), "snapshot recovery sends no further chat request").toEqual([]);
      gates.get(activePrompt)!(); gates.delete(activePrompt); await until(page, `!p.streaming(${JSON.stringify(sessionId)})`);
    } finally {
      try {
        release?.(); peer?.close(); historyWaiters.delete(sessionId);
        if (appLoaded) expect(await page!.evaluate<{ sendRestored: boolean; recording: boolean } | undefined>("window.__disposeContinuityPreparation?.()"), "preparation observer restores its fixture send method")
          .toEqual({ sendRestored: true, recording: false });
      } finally { await context.close(); }
    }
  }, 120_000);

  for (const cell of cells) {
    test(`${cell.name}: progress missed during the outage rejoins the original answer`, async () => {
      const s = await scene(cell);
      const prompt = `Hold: Sail past the Sirens (${cell.name})`;
      let release!: () => void;
      const waiting = { promise: new Promise<void>((done) => { release = done; }), release: () => release(), reads: 0 };
      try {
        await mark(s.page);
        const base = await measure(s.page);
        await drop(s);
        expect(missed.get(prompt), "a real running turn can progress while disconnected").toBeDefined();
        missed.get(prompt)!();
        expect(transcripts.get(s.A)!.at(-1)!.content, "the host retained the missed delta").toContain("Missed tide.");
        historyWaiters.set(s.A, waiting);
        await recover(s);
        for (let i = 0; waiting.reads === 0 && i < 250; i++) await hostPoll(20);
        expect(waiting.reads, "the real host is reading history asynchronously").toBeGreaterThan(0);
        advance.get(prompt)!();
        await s.page.waitForFunction(() => (window as unknown as { __marks: { nodes: Element[] } }).__marks.nodes.at(-1)?.textContent?.includes("Rowing again."));
        expect(await s.page.evaluate(() => (window as unknown as { __marks: { nodes: Element[] } }).__marks.nodes.at(-1)?.textContent), "the page really has an interior gap before replay").not.toContain("Missed tide.");
        release();
        historyWaiters.delete(s.A);
        await s.page.waitForFunction(() => document.querySelector("[data-reading-column]")?.textContent?.includes("Missed tide."));
        same("the recovered interior gap", await measure(s.page), base);
        expect(await s.page.evaluate(() => {
          const node = (window as unknown as { __marks: { nodes: Element[] } }).__marks.nodes.at(-1)!;
          return node.isConnected && node.textContent?.includes("Missed tide. Rowing again.");
        }), "recovered gap keeps the original answer and correct text order").toBe(true);
        await finishRecoveredTurn(s, cell);
      } finally {
        release();
        historyWaiters.delete(s.A);
        await s.context.close();
      }
    }, 120_000);
    test(`${cell.name}: ten drops and reconnects move nothing, keep the draft, resume the upload and send nothing`, async () => {
      const s = await scene(cell);
      try {
        const { page, net, A, B, draft } = s;
        // A mid-word caret on odd cycles, a selected word on even ones.
        const caret = draft.indexOf("Scylla") + 3;
        const word = [draft.indexOf("Ithaca"), draft.indexOf("Ithaca") + "Ithaca".length] as const;
        await mark(page);
        const initial = await measure(page);
        const sentBefore = net.sent.length;
        const log: Array<{ cycle: number; phase: string; fieldTop: number; firstTop: number | null; scrollTop: number; track: string }> = [];
        for (let cycle = 1; cycle <= 10; cycle++) {
          const [start, end] = cycle % 2 ? [caret, caret] : word;
          await page.evaluate(([a, b]) => document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!.setSelectionRange(a!, b!), [start, end]);
          const base = { ...initial, selectionStart: start, selectionEnd: end };
          same(`cycle ${cycle}, before`, await measure(page), base);
          if (cycle === 1) {
            expect(base.previews[0], "the image previews from an object URL").toStartWith("blob:");
            expect(base.pills, "a real pending follow-up is guarded").toHaveLength(1);
            expect(base.pills[0]).toContain("Then bind me to the");
            expect(base.transcriptPreviews, "a sent image body is guarded").toHaveLength(1);
            expect(base.transcriptPreviews[0]).toStartWith("blob:");
          }
          log.push({ cycle, phase: "before", ...base });

          await drop(s);
          const offline = await measure(page);
          log.push({ cycle, phase: "offline", ...offline });
          same(`cycle ${cycle}, offline`, offline, base);
          expect(offline.track, `cycle ${cycle}: the upload waits rather than failing`).toContain("waiting for connection");
          expect(await drawn(cell, page), `cycle ${cycle}: B's tracker stays drawn offline`).toEqual([B]);

          // The last reconnect lets the upload through, so it is seen to finish.
          if (cycle === 10) net.holdTracks = false;
          const uploadsBefore = net.uploads;
          net.holdQueues = true;
          await recover(s);
          expect(net.queues.length, "real queue frames were delayed after hello").toBeGreaterThan(0);
          same(`cycle ${cycle}, queue report still delayed`, await measure(page), base);
          net.holdQueues = false;
          const queueBefore = await probe(page, p => p.received("session_queue", "*"));
          const queued = net.queues.splice(0);
          for (const release of queued) release();
          await until(page, `p.received("session_queue", "*") >= ${queueBefore + queued.length}`);
          await settle(page);
          if (cycle === 10) await page.waitForFunction(() => /km/.test(document.querySelector("[data-track-chip]")?.getAttribute("aria-label") ?? ""));
          else await page.waitForFunction(() => /uploading/.test(document.querySelector("[data-track-chip]")?.getAttribute("aria-label") ?? ""));
          expect(net.uploads, `cycle ${cycle}: the upload resumed after reconnect`).toBe(uploadsBefore + 1);
          const after = await measure(page);
          log.push({ cycle, phase: "after", ...after });
          same(`cycle ${cycle}, reconnected`, after, base);
          expect(await drawn(cell, page), `cycle ${cycle}: B's tracker is drawn`).toEqual([B]);
          expect(await probe(page, (p) => p.draft()), `cycle ${cycle}: A's draft`).toEqual({ text: draft, images: 1, sessionId: A });
        }
        console.log(`#1013 ${cell.name}\n${log.map((l) => `${l.cycle}\t${l.phase}\tfield ${l.fieldTop.toFixed(2)}\tfirst ${l.firstTop?.toFixed(2)}\tscroll ${l.scrollTop}\t${l.track}`).join("\n")}`);
        expect(net.sent.slice(sentBefore).filter((t) => t === "chat_message"), "reconnecting sent no chat message").toEqual([]);
        expect(net.sent.slice(sentBefore).length, "the spy saw the page's frames").toBeGreaterThan(0);
        expect(await page.evaluate(() => (window as unknown as { __events: Array<{ type: string }> }).__events.map((e) => e.type)), "nothing blurred the field").toEqual([]);
        await hostUntil((d) => d.some((x) => x.sessionId === A && x.attachmentCount === 1 && x.preview === draft));
        await finishRecoveredTurn(s, cell);
      } finally {
        await s.context.close();
      }
    }, 300_000);

    test(`${cell.name}: an IME composition started before a drop is still active after two drops and commits normally`, async () => {
      const s = await scene(cell);
      const cdp = await s.context.newCDPSession(s.page);
      try {
        const { page, draft } = s;
        const at = draft.indexOf("toward") + "toward ".length;
        await page.evaluate((n) => document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!.setSelectionRange(n, n), at);
        await mark(page);
        // Chromium's own IME path: compositionstart and compositionupdate on the focused field.
        await cdp.send("Input.imeSetComposition", { text: "ἰθάκ", selectionStart: 4, selectionEnd: 4 });
        await settle(page);
        const composing = await measure(page);
        expect(composing.value, "the composition is in the field").toBe(`${draft.slice(0, at)}ἰθάκ${draft.slice(at)}`);
        const events = () => page.evaluate(() => (window as unknown as { __events: Array<{ type: string; data?: string | null; asked?: boolean }> }).__events);
        expect((await events()).map((e) => e.type), "a composition is open").toEqual(["compositionstart"]);

        for (let cycle = 1; cycle <= 2; cycle++) {
          await drop(s);
          same(`IME cycle ${cycle}, offline`, await measure(page), composing);
          await recover(s);
          same(`IME cycle ${cycle}, reconnected`, await measure(page), composing);
          expect((await events()).map((e) => e.type), `IME cycle ${cycle}: no compositionend forced, no blur`).toEqual(["compositionstart"]);
        }

        // The user commits: one compositionend, the one asked for, and the word lands where it was composed.
        await page.evaluate(() => { (window as unknown as { __commitAsked: boolean }).__commitAsked = true; });
        await cdp.send("Input.insertText", { text: "Ἰθάκη" });
        await settle(page);
        expect(await events(), "the commit ended the composition once").toEqual([
          { type: "compositionstart", data: "", asked: false },
          { type: "compositionend", data: "Ἰθάκη", asked: true },
        ]);
        const committed = `${draft.slice(0, at)}Ἰθάκη${draft.slice(at)}`;
        const after = await measure(page);
        expect(after.value, "the committed word is in the field").toBe(committed);
        expect([after.selectionStart, after.selectionEnd], "the caret follows the committed word").toEqual([at + 5, at + 5]);
        expect(after.sameField && after.focused, "same field, still focused").toBe(true);
        await until(page, `p.draft().text === ${JSON.stringify(committed)}`);
        await hostUntil((d) => d.some((x) => x.sessionId === s.A && x.preview === committed));
        await finishRecoveredTurn(s, cell);
      } finally {
        await cdp.detach().catch(() => {});
        await s.context.close();
      }
    }, 300_000);
  }
});

/** Native host polling is measured separately from the observation windows. */
async function hostPoll(ms: number) {
  const started = performance.now();
  waitMetrics.pollCalls++;
  await Bun.sleep(ms);
  waitMetrics.pollMs += performance.now() - started;
}
