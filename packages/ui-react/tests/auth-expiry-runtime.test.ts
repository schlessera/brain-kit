import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { generateWav, AUDIO_FIXTURES } from "./browser/offline/audio-fixtures.ts";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Warm auth expiry (#1018): real password routes, WebSocket revocation,
// Chromium microphone and IndexedDB. A held transaction proves that capture
// ends before the snapshot commits and protected DOM unmounts only afterward.
// Explicit same-account sign-in restores context without navigation; another
// host account restores nothing. Every browser cell owns its host and origin.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Local work runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING local work runtime proof: no Chrome; device-local drafts are unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
const PASSWORD = "the bow only Odysseus can string";
const SESSION = "odysseus-ithaca";
const DRAFT = "Penelope weaves the shroud by day and unpicks it by night";
let browser: Browser | undefined;
let scratch: string | undefined;
let brain = "";
let assets = "";
let passwordHash = "";
let port = 0;
let origin = "";
type Host = { app: Awaited<ReturnType<typeof createApp>>; server: ReturnType<typeof Bun.serve> };
let host: Host | undefined;

// A long conversation, so the transcript scrolls and its place means something.
const transcript: SessionHistoryMessage[] = Array.from({ length: 24 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: i % 2 === 0
    ? `Question ${i / 2 + 1}: which harbour after Aeolus' island?`
    : `Answer ${(i + 1) / 2}. ${"The winds were loosed from the bag, and the ships were driven back past every headland they had rounded. ".repeat(6)}`,
  toolCalls: [],
}));

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
const SHROUD = png([200, 180, 120]);

/** One host: its own UI database, so its own account partition key. */
async function startHost(db: string): Promise<Host> {
  const backend: AgentBackend = {
    id: "local-scripted", capabilities: { resume: true, permissions: false, thinking: false, attachments: true, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "local-scripted", label: "Local fixture" }],
    listSessions: async () => [{ id: SESSION, title: "Winds of Aeolus", createdAt: 1, lastActiveAt: Date.now(), totalCostUsd: 0, numTurns: 12 }],
    getHistory: async () => structuredClone(transcript),
    async startTurn({ bridge, sessionId }) {
      bridge.emit({ type: "session_info", sessionId: sessionId ?? SESSION, isNew: false });
      bridge.emit({ type: "result", sessionId: sessionId ?? SESSION, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  const app = await createApp({
    config: resolveServerConfig({
      BRAIN_PATH: brain, DB_PATH: resolve(scratch!, db), AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: passwordHash,
      COOKIE_SECRET: "odysseus-auth-expiry-cookie-secret-0123456789", HOST: "127.0.0.1", NODE_ENV: "test",
      BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0",
    }),
    staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 60_000,
  });
  // The same port every time: one origin, so one IndexedDB, as one browser sees one host replaced by another.
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket: app.websocket });
  port = server.port!;
  origin = `http://127.0.0.1:${port}`;
  return { app, server };
}
async function stopHost(h: Host | undefined) {
  if (!h) return;
  h.server.stop(true);
  h.app.cancelActiveTurns();
  await h.app.close();
}

beforeAll(async () => {
  if (!executablePath) return;
  if (!process.env.BRAIN_AUTH_FIXTURE_BUILT) {
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Local work fixture package build failed (${code}): ${out}\n${err}`);
  }
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-auth-expiry-"));
  brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/auth-expiry-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Local work client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  await writeFile(resolve(scratch, "shroud.png"), SHROUD);
  await writeFile(resolve(scratch, "ithaca.gpx"), '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Approaching Ithaca</name><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="0.001"/></trkseg></trk></gpx>');
  await writeFile(resolve(scratch, "microphone.wav"), generateWav(AUDIO_FIXTURES.note10s));
  passwordHash = await Bun.password.hash(PASSWORD);
  host = await startHost("ithaca.db");
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${resolve(scratch!, "microphone.wav")}`, "--autoplay-policy=no-user-gesture-required"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await stopHost(host);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
type Fixture = {
  phase(): string;
  recording(): Promise<Array<{id:string; state:string; savedThroughMs:number; chunkCount:number}>>;
  tracks(): unknown[];
  allImages(): unknown[];
  savedThrough(): number | null;
  chunkEnds(): Promise<number[]>;
  ended(): boolean[];
  readAudio(key:string, id:string): Promise<Outcome>;
  held(): boolean;
  connected(): boolean;
  accountKey(): string | null;
  vpn(): string;
  status(): { failed: boolean; pending: boolean } | null;
  activeSessionId(): string | null;
  messages(): number;
  text(): string;
  images(): Array<{ data: string; mediaType: string; name: string }>;
  reviewText(): string;
  review(text: string): void;
  resume(sessionId: string): void;
  snapshotNow(): Promise<Outcome>;
  editAndSnapshot(text: string): Promise<Outcome>;
  read(accountKey: string, key: string): Promise<Outcome>;
  list(accountKey: string): Promise<Outcome<Array<{ key: string; value: unknown }>>>;
  write(accountKey: string, key: string): Promise<Outcome>;
  firstVisible(): { anchor: string; offset: number; scrollTop: number } | null;
  scrollTo(top: number): void;
};
const fixture = <T,>(page: Page, fn: (f: Fixture) => T) => page.evaluate(`(${fn.toString()})(window.__local)`) as Promise<Awaited<T>>;
async function until(page: Page, predicate: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(`(async () => { const f = window.__local; return !!f && await (${predicate}); })()`)) return;
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed")) throw error;
    }
    await page.waitForTimeout(25);
  }
  throw new Error(`Auth fixture did not settle: ${predicate}; UI: ${(await page.locator("body").textContent())?.slice(-1000)}`);
}

/** Signs in from the page itself, so the browser keeps the cookie as it would after the login form. */
async function signIn(page: Page) {
  if (!page.url().startsWith(origin)) await page.goto(`${origin}/api/health`);
  const status = await page.evaluate(async (password) => (await fetch("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  })).status, PASSWORD);
  expect(status).toBe(200);
}

/** Booted, authenticated, connected, and the conversation replayed. */
async function ready(page: Page) {
  await until(page, "f.connected() && f.accountKey() !== null");
  await until(page, `f.activeSessionId() === ${JSON.stringify(SESSION)} && f.messages() === ${transcript.length}`);
  // Every message has made its entrance.
  await page.waitForTimeout(400);
}

/** Everything changed so far has been written, and committed. */
async function committed(page: Page) {
  await until(page, "f.status() && !f.status().pending");
  const result = await fixture(page, (f) => f.snapshotNow());
  expect(result).toEqual({ ok: true, value: undefined });
}

const field = (page: Page) => page.locator("textarea[data-composer]");

  /**
   * While armed, holds every readwrite transaction over `records` open after
   * its own requests have succeeded: a request keeps going on each until the
   * test releases them all, or aborts them all. So whichever write a
   * snapshot waits on, its own transaction is among the held. Counts the
   * writes that succeeded meanwhile.
   */
  async function armHold(page: Page, outcome: "release" | "abort") {
    await page.evaluate((outcome) => {
      const w = window as unknown as { __hold: { held: number; puts: number; finish: () => void } };
      const transaction = IDBDatabase.prototype.transaction;
      const put = IDBObjectStore.prototype.put;
      const held: IDBTransaction[] = [];
      let done = false;
      w.__hold = { held: 0, puts: 0, finish: () => {} };
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
        const tx = transaction.apply(this, args);
        const names = ([] as string[]).concat(args[0] as string | string[]);
        if (done || args[1] !== "readwrite" || !names.includes("records")) return tx;
        const store = tx.objectStore("records");
        // Issued first, so every write the caller issues next runs, and succeeds, before the spin goes on.
        let first = true;
        const spin = () => {
          if (!done && (first || held.includes(tx))) {
            first = false;
            store.get(["held", "held"]).onsuccess = spin;
          }
        };
        spin();
        return tx;
      };
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...a: Parameters<IDBObjectStore["put"]>) {
        const key = a[1];
        if (Array.isArray(key) && String(key[1]).startsWith("root:")) {
          if (!held.includes(this.transaction)) held.push(this.transaction);
          w.__hold.held = held.length;
        }
        const req = put.apply(this, a);
        if (held.includes(this.transaction)) req.addEventListener("success", () => { w.__hold.puts++; });
        return req;
      };
      w.__hold.finish = () => {
        done = true;
        IDBDatabase.prototype.transaction = transaction;
        IDBObjectStore.prototype.put = put;
        if (outcome === "abort") for (const tx of held) tx.abort();
      };
    }, outcome);
  }
let cell = 0;
async function boot(page: Page) {
  // The container has no external network; localhost is reachable. Explicit
  // browser emulation makes its online hint agree with that real host path.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true }));
  await stopHost(host); host = await startHost(`ithaca-cell-${++cell}.db`);
  await signIn(page); await page.goto(origin);
  await until(page, "f.connected() && f.accountKey() !== null");
  await fixture(page, (f) => f.resume("odysseus-ithaca"));
  await ready(page);
}
async function loginForm(page: Page) {
  await page.getByRole("textbox", { name: "Password" }).or(page.locator('input[type="password"]')).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function expire(page: Page, kind: "401" | "1008" | "revoke") {
  if (kind === "revoke") {
    expect(await page.evaluate(async () => (await fetch("/api/auth/logout", {method:"POST"})).status)).toBe(200);
  } else {
    host!.app.db.run("UPDATE principals SET expires_at = ? WHERE revoked_at IS NULL AND kind = 'owner'", [Date.now() - 1]);
    if (kind === "1008") {
      const ids = host!.app.db.query("SELECT id FROM principals WHERE kind='owner'").all() as {id:string}[];
      host!.app.wsHost.revokePrincipals(ids.map((r) => r.id), 1008, "Session expired");
    } else await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
}

for (const kind of ["401", "1008"] as const) describe.skipIf(!executablePath)(`warm auth expiry ${kind} (#1018)`, () => {
  test("capture ends; snapshot commits before unmount; same account restores all context without navigation", async () => {
    const context = await browser!.newContext({viewport:{width:900,height:700}});
    const page = await context.newPage();
    try {
      await boot(page);
      const key = (await fixture(page, (f) => f.accountKey()))!;
      await fixture(page, (f) => f.scrollTo(900));
      await field(page).fill(DRAFT);
      await page.locator('input[type="file"][accept="image/*"][multiple]').setInputFiles(resolve(scratch!, "shroud.png"));
      await until(page, "f.images().length === 1");
      await page.locator('input[type="file"][accept^=".gpx"]').setInputFiles(resolve(scratch!, "ithaca.gpx"));
      await until(page, "f.tracks().length === 1");
      await page.getByRole("button", {name:"Start local recording", exact:true}).click();
      await until(page, "f.recording().then(r => r[0]?.chunkCount > 0)");
      await field(page).focus();
      await field(page).evaluate((el:HTMLTextAreaElement) => el.setSelectionRange(12,26));
      await committed(page);
      const before = {tracks:await fixture(page,(f)=>f.tracks()), images:await fixture(page,(f)=>f.images()), place:(await fixture(page,(f)=>f.firstVisible()))!};
      expect(before.images.length).toBe(1);
      expect(before.tracks.length, "uploaded track reference is nonempty").toBe(1);
      expect(Number(before.place.anchor)).toBeGreaterThan(0);
      const protectedHtml = await page.evaluate(() => document.documentElement.outerHTML);
      for (const text of ["Winds of Aeolus", "winds were loosed", "shroud.png"]) expect(protectedHtml, `fixture ${text} is present before expiry`).toContain(text);
      await armHold(page, "release");
      // Change text immediately before expiry, so snapshot has a real write.
      await page.evaluate(() => {
        const el=document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
        el.setSelectionRange(14,28);
      });
      await expire(page,kind);
      await until(page,"f.phase() === 'locked' || window.__hold.puts > 0");
      expect(await field(page).count(),"protected composer stays mounted until snapshot commit").toBe(1);
      expect(await page.evaluate(() => (window as unknown as {__hold:{puts:number}}).__hold.puts),"snapshot has real writes awaiting commit").toBeGreaterThan(0);
      expect(await page.locator('[data-reading-column]').count(),"transcript stays mounted until snapshot commit").toBe(1);
      expect(await fixture(page,(f)=>f.held()),"update reload held during capture stop and snapshot").toBe(true);
      expect((await fixture(page,(f)=>f.ended())).length,"microphone was opened").toBeGreaterThan(0);
      expect((await fixture(page,(f)=>f.ended())).every(Boolean),"all microphone tracks ended before unmount").toBe(true);
      // An edit while the transaction is pending must join the final snapshot.
      const latest = `${DRAFT}. Odysseus returns to Ithaca.`;
      await field(page).fill(latest);
      await field(page).evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(16,30));
      await page.evaluate(() => (window as unknown as {__hold:{finish():void}}).__hold.finish());
      await until(page,"f.phase() === 'locked' && f.accountKey() === null");
      if (kind === "1008") expect(await page.getByText("Your sign-in has expired",{exact:true}).count(),"expiry close uses expired copy").toBe(1);
      else expect(await page.getByText(/^(Your sign-in has expired|This device was signed out)$/).count(),"401 and any concurrent invalidation show neutral reauth copy").toBe(1);
      expect(await field(page).count(),"protected composer unmounted").toBe(0);
      const html=await page.evaluate(()=>document.documentElement.outerHTML);
      for(const text of [DRAFT,"Winds of Aeolus","winds were loosed","shroud.png"]) expect(html,`protected ${text} absent from entire document`).not.toContain(text);
      expect(await fixture(page,(f)=>f.text()),"draft payload dropped in memory").toBe("");
      expect(await fixture(page,(f)=>f.held()),"auth holds update reload after all payloads and other holds cleared").toBe(true);
      const savedThrough = await fixture(page,(f)=>f.savedThrough());
      expect(savedThrough, "stopped recording has a committed boundary").toBeGreaterThan(0);
      const seconds=Math.floor(savedThrough! / 1000);
      await page.getByText(`Recording stopped. Saved up to ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}.`,{exact:true}).waitFor();
      expect(await page.evaluate((key)=>(window as unknown as {__local:Fixture}).__local.list(key), key)).toEqual({ok:false,error:"PartitionRefusedError"});
      let navigations=0; const count=()=>navigations++; page.on("framenavigated",count);
      await page.waitForTimeout(400); // login entrance settled
      await loginForm(page);
      await ready(page);
      await page.waitForTimeout(1800);
      expect(navigations,"same-account sign-in has no navigation").toBe(0);
      expect(await field(page).inputValue(),"edits during snapshot commit restored").toBe(latest);
      expect(await fixture(page,(f)=>f.images()),"attachments restored").toEqual(before.images);
      expect(await fixture(page,(f)=>f.tracks()),"uploaded track references restored").toEqual(before.tracks);
      expect(await field(page).evaluate((el:HTMLTextAreaElement)=>[el.selectionStart,el.selectionEnd]),"selection restored").toEqual([16,30]);
      expect(await field(page).evaluate((el)=>document.activeElement===el),"focus restored").toBe(true);
      const after=(await fixture(page,(f)=>f.firstVisible()))!;
      expect(after.anchor,"same scroll anchor").toBe(before.place.anchor);
      expect(Math.abs(after.offset-before.place.offset),"scroll offset within 1px").toBeLessThanOrEqual(1);
      const rows=await fixture(page,(f)=>f.recording());
      expect(rows).toHaveLength(1); expect(rows[0]!.state,"auth outcome interrupted").toBe("interrupted");
      expect(rows[0]!.savedThroughMs, "restored recording keeps stopped boundary").toBe(savedThrough!);
      const ends=await fixture(page,(f)=>f.chunkEnds());
      expect(ends.length, "recording has durable chunks").toBeGreaterThan(0);
      expect(Math.max(...ends), "boundary equals last committed chunk end").toBe(savedThrough!);
      if (kind === "1008") {
        await field(page).fill("Telemachus asks Nestor about the fleet");
        await expire(page, "1008"); await until(page, "f.phase() === 'locked' && f.accountKey() === null");
        await page.waitForTimeout(400); await loginForm(page); await ready(page);
        expect(await field(page).inputValue(), "a second warm restore uses fresh managers").toBe("Telemachus asks Nestor about the fleet");
        expect(navigations, "repeated same-account restore never navigates").toBe(0);
      }
      page.off("framenavigated",count);
    } finally { await context.close(); }
  },120_000);
});

describe.skipIf(!executablePath)("auth boundary failures and revocation (#1018)",()=>{
 test("failed snapshot is reported; revocation uses signed-out copy",async()=>{
  const context=await browser!.newContext({viewport:{width:900,height:700}}); const page=await context.newPage();
  try {
   await boot(page); await field(page).fill(DRAFT); await committed(page);
   await armHold(page,"abort"); await field(page).evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(2,5));
   await expire(page,"revoke");
   await page.waitForFunction(()=>(window as unknown as {__hold:{puts:number}}).__hold.puts>0);
   expect(await field(page).count(),"still mounted before abort").toBe(1);
   await page.evaluate(()=>(window as unknown as {__hold:{finish():void}}).__hold.finish());
   await until(page,"f.phase() === 'locked' && f.accountKey() === null");
   expect(await page.getByText("Your draft couldn't be saved on this device.",{exact:true}).count(),"failed snapshot is reported on neutral reauth screen").toBe(1);
   expect(await field(page).count()).toBe(0);
   expect(await page.getByText("This device was signed out",{exact:true}).count()).toBe(1);
   let navigations=0; page.on("framenavigated",()=>navigations++);
   await page.waitForTimeout(400); await loginForm(page);
   await until(page,"f.connected() && f.accountKey() !== null");
   expect(navigations,"same-account sign-in reloads after a failed snapshot").toBeGreaterThan(0);
  } finally { await context.close(); }
 },120_000);
 test("different account navigates and cannot read or restore prior drafts or audio",async()=>{
  const context=await browser!.newContext({viewport:{width:900,height:700}}); const page=await context.newPage();
  try {
   await boot(page); const key=(await fixture(page,(f)=>f.accountKey()))!;
   await field(page).fill(DRAFT); await committed(page);
   await page.getByRole("button",{name:"Start local recording",exact:true}).click();
   await until(page,"f.recording().then(r => r[0]?.chunkCount > 0)");
   const rows=await fixture(page,(f)=>f.recording());
   await expire(page,"1008"); await until(page,"f.phase() === 'locked' && f.accountKey() === null");
   await stopHost(host); host=await startHost("pylos.db");
   let navigations=0; page.on("framenavigated",()=>navigations++);
   await page.waitForTimeout(400); await loginForm(page);
   await until(page,"f.connected() && f.accountKey() !== null");
   await page.waitForTimeout(500);
   expect(navigations,"different-account sign-in navigates").toBeGreaterThan(0);
   expect(await fixture(page,(f)=>f.accountKey())).not.toBe(key);
   expect(await field(page).inputValue(),"prior draft not restored").toBe("");
   expect(await fixture(page,(f)=>f.recording()),"prior audio not listed").toEqual([]);
   await page.locator("[data-locked-recordings]").waitFor();
   expect(await page.locator("[data-locked-recordings]").textContent()).toMatch(/^Locked recordings from another account · [0-9.]+ MB$/);
   expect(await page.evaluate((key)=>(window as unknown as {__local:Fixture}).__local.list(key), key),"prior partition cannot be read").toEqual({ok:false,error:"PartitionRefusedError"});
   expect(await page.evaluate(([key,id])=>(window as unknown as {__local:Fixture}).__local.readAudio(key!,id!), [key,rows[0]!.id]),"prior audio cannot play").toEqual({ok:false,error:"PartitionRefusedError"});
   expect(await page.evaluate(()=>document.documentElement.outerHTML)).not.toContain(DRAFT);
  } finally { await stopHost(host); host=await startHost("ithaca.db"); await context.close(); }
 },120_000);
});


describe.skipIf(!executablePath)("auth producer and identity races (#1018)",()=>{
 test("an image decode finishing after lock cannot recreate account drafts",async()=>{
  const context=await browser!.newContext({viewport:{width:900,height:700}}); const page=await context.newPage();
  try {
   await boot(page); await field(page).fill(DRAFT); await committed(page);
   await page.evaluate(()=>{
    const original=window.createImageBitmap; let release!:()=>void;
    const gate=new Promise<void>(yes=>release=yes);
    Object.assign(window,{__decode:{started:0,done:0,release}});
    const deferredBitmap=async(...args:Parameters<typeof createImageBitmap>)=>{
     (window as any).__decode.started++; const bitmap=await original(...args); await gate;
     (window as any).__decode.done++; return bitmap;
    };
    window.createImageBitmap=deferredBitmap as typeof createImageBitmap;
   });
   await page.locator('input[type="file"][accept="image/*"][multiple]').setInputFiles(resolve(scratch!,"shroud.png"));
   await page.waitForFunction(()=>(window as any).__decode.started===1);
   await expire(page,"1008"); await until(page,"f.phase() === 'locked' && f.accountKey() === null");
   await page.evaluate(()=>(window as any).__decode.release());
   await page.waitForFunction(()=>(window as any).__decode.done===1); await page.waitForTimeout(300);
   expect(await fixture(page,f=>f.allImages()),"late image decode cannot repopulate locked drafts").toEqual([]);
   expect(await fixture(page,f=>f.text())).toBe("");
   await page.waitForTimeout(400); await loginForm(page); await ready(page);
   expect(await field(page).inputValue(),"saved text survives the delayed image callback").toBe(DRAFT);
   expect(await fixture(page,f=>f.images())).toEqual([]);
  } finally {await context.close();}
 },120_000);
 test("track-only New chat restores the same unbound composer identity",async()=>{
  const context=await browser!.newContext({viewport:{width:900,height:700}}); const page=await context.newPage();
  try {
   await boot(page); await page.getByRole("button",{name:"New chat",exact:true}).click();
   await until(page,"f.activeSessionId() === null");
   await page.locator('input[type="file"][accept^=".gpx"]').setInputFiles(resolve(scratch!,"ithaca.gpx"));
   await until(page,"f.tracks().length === 1"); const refs=await fixture(page,f=>f.tracks());
   expect(await field(page).inputValue()).toBe(""); await committed(page);
   await expire(page,"1008"); await until(page,"f.phase() === 'locked' && f.accountKey() === null");
   await page.waitForTimeout(400); await loginForm(page); await until(page,"f.phase() === 'active' && f.connected()");
   expect(await fixture(page,f=>f.activeSessionId()),"New chat stays unbound").toBeNull();
   expect(await fixture(page,f=>f.tracks()),"track-only unbound draft restored").toEqual(refs);
   expect(await page.getByText("ithaca.gpx",{exact:true}).count(),"restored track chip visible").toBe(1);
  } finally {await context.close();}
 },120_000);
});
