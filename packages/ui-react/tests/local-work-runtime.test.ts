import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// The work context kept on this device (#1014), end to end: the real app in
// password mode, the public ConnectionGate and ChatPage, real Chrome and its
// real IndexedDB. The partition key comes from the host's probe; the draft,
// its selection and focus, an image, the voice review text and the place in
// the transcript survive a reload; nothing of one account's partition can be
// read, written or shown without holding its key; a snapshot resolves only
// once its transaction has committed; and a write the browser refuses is
// said, never shown as kept. Keyless: the backend is scripted.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Local work runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING local work runtime proof: no Chrome; device-local drafts are unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
const PASSWORD = "the bow only Odysseus can string";
const SESSION = "odysseus-ithaca";
const SECOND_SESSION = "odysseus-pylos";
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
    listSessions: async () => [SESSION, SECOND_SESSION].map(id => ({ id, title: id === SESSION ? "Winds of Aeolus" : "The harbour at Pylos", createdAt: 1, lastActiveAt: Date.now(), totalCostUsd: 0, numTurns: 12 })),
    getHistory: async () => structuredClone(transcript),
    async startTurn({ bridge, sessionId }) {
      bridge.emit({ type: "session_info", sessionId: sessionId ?? SESSION, isNew: false });
      bridge.emit({ type: "result", sessionId: sessionId ?? SESSION, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  const app = await createApp({
    config: resolveServerConfig({
      BRAIN_PATH: brain, DB_PATH: resolve(scratch!, db), AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: passwordHash,
      COOKIE_SECRET: "odysseus-local-work-cookie-secret-0123456789", HOST: "127.0.0.1", NODE_ENV: "test",
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

const hook = runtimeHookPhases("local-work-runtime");

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts", "--for", "ui-react,ui-server,core"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await hook.child("package-build", build);
  if (code !== 0) throw new Error(`Local work fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-local-work-"));
  brain = resolve(scratch, "brain");
  await hook.phase("fixture-brain", () => createFixtureBrain(repo, brain));
  assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/local-work-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await hook.child("client-build", bundle);
  if (bundleCode !== 0) throw new Error(`Local work client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  await writeFile(resolve(scratch, "shroud.png"), SHROUD);
  passwordHash = await Bun.password.hash(PASSWORD);
  host = await hook.phase("host-start", () => startHost("ithaca.db"));
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 }));
}, 180_000);

afterAll(() => hook.phase("cleanup", async () => {
  await browser?.close();
  await stopHost(host);
  if (scratch) await rm(scratch, { recursive: true, force: true });
}));

type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
type Fixture = {
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
  restoring(): Promise<void>;
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
  await page.waitForFunction(`(() => { const f = window.__local; return !!f && (${predicate}); })()`, undefined, { timeout });
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
  // An idle write queue can precede the initial asynchronous account binding (#1324).
  await fixture(page, f => f.restoring());
  await until(page, "f.status() && !f.status().pending");
  const result = await fixture(page, (f) => f.snapshotNow());
  expect(result).toEqual({ ok: true, value: undefined });
}

const field = (page: Page) => page.locator("textarea[data-composer]");

describe.skipIf(!executablePath)("device-local work context (#1014)", () => {
  test("a cold tab's own context resumes history after another tab's initial replay finished", async () => {
    const context = await browser!.newContext({ viewport: { width: 900, height: 700 } });
    await context.routeWebSocket(/\/ws$/, (route) => {
      const upstream = route.connectToServer();
      route.onMessage(message => upstream.send(message));
      upstream.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (frame.type === "server_hello" && frame.capabilities) delete frame.capabilities.sessionDrafts;
        route.send(JSON.stringify(frame));
      });
    });
    const a = await context.newPage();
    try {
      await signIn(a);
      await a.goto(origin);
      await until(a, "f.connected() && f.accountKey() !== null");
      await fixture(a, f => f.resume("odysseus-ithaca"));
      await ready(a);
      await field(a).fill(DRAFT);
      await committed(a);
      const b = await context.newPage();
      await b.goto(origin);
      await until(b, "f.connected() && f.accountKey() !== null");
      await fixture(b, f => f.resume("odysseus-pylos"));
      await until(b, 'f.activeSessionId() === "odysseus-pylos" && f.messages() === 24');
      await committed(b);
      await a.addInitScript(() => {
        const original = IDBObjectStore.prototype.getAll;
        let gated = false;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        Object.assign(window, { __restoreHeld: false, __releaseRestore: () => release() });
        IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
          const req = original.apply(this, args);
          const range = args[0];
          if (!gated && this.transaction.mode === "readonly" && range instanceof IDBKeyRange &&
            Array.isArray(range.lower) && range.lower[1] === "root:odysseus-local/") {
            gated = true;
            Object.defineProperty(req, "onsuccess", { configurable: true, set(fn) {
              req.addEventListener("success", async event => {
                Object.assign(window, { __restoreHeld: true });
                await gate;
                fn.call(req, event);
              }, { once: true });
            } });
          }
          return req;
        };
      });
      await a.reload();
      await a.waitForFunction(() => (window as unknown as { __restoreHeld: boolean }).__restoreHeld);
      await until(a, 'f.connected() && f.activeSessionId() === "odysseus-pylos" && f.messages() === 24');
      await a.evaluate(() => (window as unknown as { __releaseRestore(): void }).__releaseRestore());
      await until(a, 'f.activeSessionId() === "odysseus-ithaca"');
      await until(a, 'f.messages() === 24', 3000).catch(() => {});
      expect(await fixture(a, f => f.messages()), "the restored tab's conversation history resumes after its own context changes selection").toBe(24);
      expect(await field(a).inputValue()).toBe(DRAFT);
    } finally { await context.close(); }
  }, 120_000);

  test("a draft with a selection, an image and review text survives a reload; the transcript returns to its place", async () => {
    const context = await browser!.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto(origin);
      await until(page, "f.connected() && f.accountKey() !== null");
      await fixture(page, (f) => f.resume("odysseus-ithaca"));
      await ready(page);

      await fixture(page, (f) => f.scrollTo(900));
      await field(page).click();
      await field(page).fill(DRAFT);
      // A selection that starts mid-word: "wea|ves the shr|oud".
      await field(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(12, 26));
      await page.locator('input[type="file"][accept="image/*"][multiple]').setInputFiles(resolve(scratch!, "shroud.png"));
      await until(page, "f.images().length === 1");
      await fixture(page, (f) => f.review("and the suitors never noticed"));
      await field(page).focus();
      await field(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(12, 26));
      await committed(page);

      const before = {
        text: await fixture(page, (f) => f.text()),
        images: await fixture(page, (f) => f.images()),
        review: await fixture(page, (f) => f.reviewText()),
        selection: await field(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
        place: (await fixture(page, (f) => f.firstVisible()))!,
      };
      expect(before.text).toBe(DRAFT);
      expect(before.images).toHaveLength(1);
      expect(before.images[0]!.data.length).toBeGreaterThan(0);
      expect(before.selection).toEqual([12, 26]);
      // Read mid-transcript: not the top, not the tail.
      expect(Number(before.place.anchor)).toBeGreaterThan(0);
      expect(before.place.scrollTop).toBeGreaterThan(0);

      await page.reload();
      await ready(page);
      // Given time to come back; the assertions below say what did.
      await until(page, `f.text() === ${JSON.stringify(DRAFT)}`, 5_000).catch(() => {});
      // The transcript's place is held for a moment against late layout.
      await page.waitForTimeout(1_800);

      expect(await field(page).inputValue(), "the draft text").toBe(DRAFT);
      expect(await fixture(page, (f) => f.images()), "the image's bytes").toEqual(before.images);
      expect(await fixture(page, (f) => f.reviewText()), "the review text").toBe(before.review);
      expect(await field(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]), "the selection").toEqual(before.selection);
      expect(await page.evaluate(() => document.activeElement?.matches("textarea[data-composer]") ?? false), "focus is in the field").toBe(true);
      const after = (await fixture(page, (f) => f.firstVisible()))!;
      expect(after.anchor, "the same first visible message").toBe(before.place.anchor);
      expect(Math.abs(after.offset - before.place.offset), "its offset, within 1px").toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("without the account's key the partition refuses every read and write, and nothing of it is shown", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 760 } });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto(origin);
      await until(page, "f.connected() && f.accountKey() !== null");
      await fixture(page, (f) => f.resume("odysseus-ithaca"));
      await ready(page);
      const keyA = (await fixture(page, (f) => f.accountKey()))!;
      await field(page).fill("The Cyclops' cave, and a name: Nobody");
      await committed(page);
      const stored = await fixture(page, (f) => f.list(f.accountKey()!));
      expect(stored.ok && stored.value.some((r) => JSON.stringify(r.value).includes("Nobody")), "the draft is in partition A").toBe(true);

      // Signed out: the login screen, no key, and the module refuses partition A.
      const out = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status);
      expect(out).toBe(200);
      await page.reload();
      await until(page, "f.vpn() === \"unauthorized\" && f.accountKey() === null");
      expect(await fixture(page, (f) => f.read(f.accountKey() ?? "", "x"))).toEqual({ ok: false, error: "PartitionRefusedError" });
      expect(await page.evaluate((key) => (window as unknown as { __local: Fixture }).__local.list(key), keyA)).toEqual({ ok: false, error: "PartitionRefusedError" });
      expect(await page.evaluate((key) => (window as unknown as { __local: Fixture }).__local.write(key, "intruder"), keyA)).toEqual({ ok: false, error: "PartitionRefusedError" });
      expect(await page.locator("textarea[data-composer]").count(), "no composer while signed out").toBe(0);
      expect(await page.locator("body").innerText()).not.toContain("Nobody");

      // The same owner again: the same key, and the draft back.
      await signIn(page);
      await page.reload();
      await ready(page);
      expect(await fixture(page, (f) => f.accountKey())).toBe(keyA);
      await until(page, `f.text() === ${JSON.stringify("The Cyclops' cave, and a name: Nobody")}`);

      // Holding another key while A's work is in this page's stores: the page starts again.
      const navigated = page.waitForEvent("framenavigated", { timeout: 10_000 });
      await page.evaluate(() => (window as unknown as { __local: { holdKey(key: string): void } }).__local.holdKey("telemachus-key-0001"));
      expect(await navigated.then(() => true, () => false), "the page reloads").toBe(true);
      await ready(page);
      expect(await fixture(page, (f) => f.accountKey()), "the host's key again, after the reload").toBe(keyA);

      // Another host on the same origin: another key. Nothing of A restores or opens.
      await stopHost(host);
      host = await startHost("pylos.db");
      await page.reload();
      await signIn(page);
      await page.reload();
      await until(page, "f.connected() && f.accountKey() !== null");
      await fixture(page, (f) => f.resume("odysseus-ithaca"));
      await ready(page);
      const keyB = (await fixture(page, (f) => f.accountKey()))!;
      expect(keyB).not.toBe(keyA);
      expect(await page.evaluate((key) => (window as unknown as { __local: Fixture }).__local.read(key, "x"), keyA)).toEqual({ ok: false, error: "PartitionRefusedError" });
      expect(await page.evaluate((key) => (window as unknown as { __local: Fixture }).__local.write(key, "intruder"), keyA)).toEqual({ ok: false, error: "PartitionRefusedError" });
      expect(await field(page).inputValue(), "nothing of A in the composer").toBe("");
      expect(await page.locator("body").innerText()).not.toContain("Nobody");
    } finally {
      await stopHost(host);
      host = await startHost("ithaca.db");
      await context.close();
    }
  }, 120_000);

  /**
   * Hold the native writes open until release, or abort them while keeping
   * the same storage fault active through the failed-write observations.
   * Otherwise a queued autosave can commit after the explicit abort and
   * legitimately clear the failure before the test observes it (#2355).
   */
  async function armHold(page: Page, outcome: "release" | "abort") {
    await page.evaluate((outcome) => {
      const transaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!;
      const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!;
      const previousHold = Object.getOwnPropertyDescriptor(window, "__hold");
      const owned: { tx: IDBTransaction; settled: boolean; aborting: boolean; completion: Promise<void> }[] = [];
      let phase: "holding" | "released" | "aborted" = "holding";
      const restoreMethods = () => {
        Object.defineProperty(IDBDatabase.prototype, "transaction", transaction);
        Object.defineProperty(IDBObjectStore.prototype, "put", put);
      };
      const abort = (entry: typeof owned[number]) => {
        if (!entry.settled && !entry.aborting) { entry.aborting = true; entry.tx.abort(); }
      };
      const drain = async () => {
        // Native completion can release another already queued writer.
        for (let count = 0; count < owned.length;) {
          const pending = owned.slice(count); count = owned.length;
          await Promise.all(pending.map(entry => entry.completion));
        }
      };
      const state = {
        held: 0, puts: 0, afterFinishSettled: 0,
        async finish() {
          phase = outcome === "abort" ? "aborted" : "released";
          if (phase === "released") restoreMethods();
          else for (const entry of owned) abort(entry);
          await drain();
        },
        async restore() {
          // Failure paths also stop every held request and await native close.
          phase = "aborted";
          for (const entry of owned) abort(entry);
          await drain();
          restoreMethods();
          if (previousHold) Object.defineProperty(window, "__hold", previousHold);
          else Reflect.deleteProperty(window, "__hold");
          const same = (a: PropertyDescriptor, b: PropertyDescriptor) =>
            ["value", "get", "set", "writable", "configurable", "enumerable"].every(k => a[k as keyof PropertyDescriptor] === b[k as keyof PropertyDescriptor]);
          return { owned: owned.length, settled: owned.filter(entry => entry.settled).length,
            descriptorsRestored: same(Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!, transaction) &&
              same(Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!, put) &&
              (previousHold ? same(Object.getOwnPropertyDescriptor(window, "__hold")!, previousHold) : !Object.hasOwn(window, "__hold")) };
        },
      };
      Object.defineProperty(window, "__hold", { configurable: true, value: state });
      Object.defineProperty(IDBDatabase.prototype, "transaction", { ...transaction,
        value: function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
          const tx = transaction.value.apply(this, args) as IDBTransaction;
          const names = ([] as string[]).concat(args[0] as string | string[]);
          if (args[1] !== "readwrite" || !names.includes("records")) return tx;
          const afterFinish = phase === "aborted";
          let settle!: () => void;
          const entry = { tx, settled: false, aborting: false, completion: new Promise<void>(resolve => { settle = resolve; }) };
          const completed = () => { entry.settled = true; if (afterFinish) state.afterFinishSettled++; settle(); };
          tx.addEventListener("complete", completed, { once: true });
          tx.addEventListener("abort", completed, { once: true });
          owned.push(entry); state.held = owned.length;
          if (afterFinish) { abort(entry); return tx; }
          const store = tx.objectStore("records");
          // Each caller's requests succeed before the next keepalive request.
          const spin = () => { if (phase === "holding") store.get(["held", "held"]).onsuccess = spin; };
          spin();
          return tx;
        },
      });
      Object.defineProperty(IDBObjectStore.prototype, "put", { ...put,
        value: function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
          const request = put.value.apply(this, args) as IDBRequest;
          if (owned.some(entry => entry.tx === this.transaction)) request.addEventListener("success", () => { state.puts++; });
          return request;
        },
      });
    }, outcome);
    let receipt: { owned: number; settled: number; descriptorsRestored: boolean } | undefined;
    return async () => receipt ??= await page.evaluate(() => (window as unknown as {
      __hold: { restore(): Promise<{ owned: number; settled: number; descriptorsRestored: boolean }> };
    }).__hold.restore());
  }
  const hold = (page: Page) => page.evaluate(() => (window as unknown as { __hold: { held: number; puts: number } }).__hold);
  async function startSnapshot(page: Page, text: string) {
    await page.evaluate((text) => {
      const w = window as unknown as { __local: Fixture; __snap: { done: boolean; result?: Outcome } };
      w.__snap = { done: false };
      void w.__local.editAndSnapshot(text).then((result) => { w.__snap = { done: true, result }; });
    }, text);
  }
  const snap = (page: Page) => page.evaluate(() => (window as unknown as { __snap: { done: boolean; result?: Outcome } }).__snap);

  test("two authenticated tabs retain divergent local versions under a racing native commit", async () => {
    const context = await browser!.newContext({ viewport: { width: 900, height: 700 } });
    // Exercise the device fallback through the real password login/account probe.
    await context.routeWebSocket(/\/ws$/, (route) => {
      const upstream = route.connectToServer();
      route.onMessage((message) => upstream.send(message));
      upstream.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "server_hello" && frame.capabilities) delete frame.capabilities.sessionDrafts;
        route.send(JSON.stringify(frame));
      });
    });
    const a = await context.newPage();
    const b = await context.newPage();
    let restoreHold: Awaited<ReturnType<typeof armHold>> | undefined;
    try {
      await signIn(a);
      await a.goto(origin);
      await until(a, "f.connected() && f.accountKey() !== null");
      await fixture(a, (f) => f.resume("odysseus-ithaca"));
      await ready(a);
      expect(await fixture(a, (f) => f.editAndSnapshot("Penelope's first weave"))).toEqual({ ok: true, value: undefined });
      const key = (await fixture(a, (f) => f.accountKey()))!;
      const baseline = await fixture(a, (f) => f.list(f.accountKey()!));
      if (!baseline.ok) throw new Error(baseline.error);
      const original = baseline.value.find(r => (r.value as { text?: string }).text === "Penelope's first weave")!;
      expect(original).toBeDefined();
      await b.goto(origin);
      await ready(b);
      expect(await fixture(b, (f) => f.accountKey()), "both tabs hold the authenticated account key").toBe(key);
      expect(await field(b).inputValue()).toBe("Penelope's first weave");

      restoreHold = await armHold(a, "release");
      await startSnapshot(a, "Penelope keeps the committed weave");
      await a.waitForFunction(() => (window as unknown as { __hold: { puts: number } }).__hold.puts > 0);
      await startSnapshot(b, "Telemachus keeps his own voyage");
      expect((await snap(b)).done).toBe(false);
      await a.evaluate(() => (window as unknown as { __hold: { finish(): Promise<void> } }).__hold.finish());
      for (const page of [a, b]) await page.waitForFunction(() => (window as unknown as { __snap: { done: boolean } }).__snap.done);
      expect((await snap(a)).result).toEqual({ ok: true, value: undefined });
      expect((await snap(b)).result).toEqual({ ok: true, value: undefined });
      const after = await fixture(b, (f) => f.list(f.accountKey()!));
      if (!after.ok) throw new Error(after.error);
      expect((after.value.find(r => r.key === original.key)!.value as { text: string }).text,
        "the authenticated original survives the atomic stale write").toBe("Penelope keeps the committed weave");
      const branch = after.value.find(r => (r.value as { text?: string }).text === "Telemachus keeps his own voyage");
      expect(branch, "the authenticated incoming branch is durable").toBeDefined();
      expect((branch!.value as { sessionId: string | null }).sessionId).toBeNull();
      expect(await field(b).inputValue()).toBe("Telemachus keeps his own voyage");
      await b.reload();
      await ready(b);
      expect(await field(b).inputValue(), "the authenticated tab resumes its own branch").toBe("Telemachus keeps his own voyage");
      expect(await b.locator("[data-device-conflict]").innerText()).toContain("Both versions kept");
    } finally {
      try {
        if (restoreHold) {
          const restored = await restoreHold();
          expect(restored.descriptorsRestored).toBe(true);
          expect(restored.settled).toBe(restored.owned);
        }
      } finally { await context.close(); }
    }
  }, 120_000);

  test("snapshotNow resolves only once its transaction has committed, and rejects when it aborts", async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let restoreHold: Awaited<ReturnType<typeof armHold>> | undefined;
    try {
      await signIn(page);
      await page.goto(origin);
      await until(page, "f.connected() && f.accountKey() !== null");
      await committed(page);

      // Its own transaction, its writes done, not yet committed.
      restoreHold = await armHold(page, "release");
      await startSnapshot(page, "The raft, and Calypso's island behind it");
      await page.waitForFunction(() => (window as unknown as { __hold: { puts: number } }).__hold.puts > 0, undefined, { timeout: 5_000 });
      await page.waitForTimeout(500);
      expect((await hold(page)).held, "its writes are in a held transaction").toBeGreaterThan(0);
      expect((await snap(page)).done, "not resolved while its transaction is open").toBe(false);
      await page.evaluate(() => (window as unknown as { __hold: { finish: () => Promise<void> } }).__hold.finish());
      await page.waitForFunction(() => (window as unknown as { __snap: { done: boolean } }).__snap.done, undefined, { timeout: 5_000 });
      expect((await snap(page)).result).toEqual({ ok: true, value: undefined });
      const stored = await fixture(page, (f) => f.list(f.accountKey()!));
      expect(stored.ok && stored.value.some((r) => JSON.stringify(r.value).includes("Calypso")), "committed when it resolved").toBe(true);

      // The same, aborted after its writes succeeded: no receipt, and the failure is said.
      const released = await restoreHold();
      expect(released.descriptorsRestored).toBe(true);
      expect(released.settled).toBe(released.owned);
      restoreHold = await armHold(page, "abort");
      await startSnapshot(page, "Ogygia, seven years");
      await page.waitForFunction(() => (window as unknown as { __hold: { puts: number } }).__hold.puts > 0, undefined, { timeout: 5_000 });
      await page.evaluate(() => (window as unknown as { __hold: { finish: () => Promise<void> } }).__hold.finish());
      await page.waitForFunction(() => (window as unknown as { __snap: { done: boolean } }).__snap.done, undefined, { timeout: 5_000 });
      expect((await snap(page)).result, "an aborted snapshot rejects").toEqual({ ok: false, error: "AbortError" });
      expect(await fixture(page, (f) => f.status()?.failed)).toBe(true);
      const after = await fixture(page, (f) => f.list(f.accountKey()!));
      expect(after.ok && after.value.some((r) => JSON.stringify(r.value).includes("Ogygia")), "nothing of it was kept").toBe(false);

      // A genuine later autosave must not escape the owned native abort
      // window and invalidate the original status/data observations.
      const before = await page.evaluate(() => (window as unknown as { __hold: { afterFinishSettled: number } }).__hold.afterFinishSettled);
      await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
      await page.waitForFunction(before => (window as unknown as { __hold: { afterFinishSettled: number } }).__hold.afterFinishSettled > before, before, { timeout: 5_000 });
      expect(await fixture(page, f => f.status()?.failed), "ABORTED_SNAPSHOT_REJECTS_QUEUED_RECOVERY").toBe(true);
      const afterQueued = await fixture(page, f => f.list(f.accountKey()!));
      expect(afterQueued.ok && afterQueued.value.some(r => JSON.stringify(r.value).includes("Ogygia")), "a queued writer cannot keep the failed snapshot during its abort window").toBe(false);
    } finally {
      try {
        if (restoreHold) {
          const restored = await restoreHold();
          expect(restored.descriptorsRestored).toBe(true);
          expect(restored.settled).toBe(restored.owned);
        }
      } finally { await context.close(); }
    }
  }, 120_000);

  test("a quota failure is said in the hint, the draft stays editable, and nothing claims it was kept", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 760 } });
    // A host that keeps no drafts: the line's one claim is `kept on this device`.
    await context.routeWebSocket(/\/ws$/, (route) => {
      const upstream = route.connectToServer();
      route.onMessage((message) => upstream.send(message));
      upstream.onMessage((message) => {
        try {
          const frame = JSON.parse(String(message)) as { type?: string; capabilities?: Record<string, boolean> };
          if (frame.type === "server_hello" && frame.capabilities) delete frame.capabilities.sessionDrafts;
          route.send(JSON.stringify(frame));
        } catch {
          route.send(message);
        }
      });
    });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto(origin);
      await until(page, "f.connected() && f.accountKey() !== null");
      const line = page.locator("[data-draft-save]");
      await field(page).fill("Scylla on one side");
      await committed(page);
      expect(await line.textContent(), "kept, and said so").toBe("draft · this host doesn't keep drafts · kept on this device");

      await page.evaluate(() => {
        IDBObjectStore.prototype.put = function () { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
      });
      const failure = "Couldn't save your draft on this device.";
      await field(page).fill("Scylla on one side, Charybdis on the other");
      const said = await page.getByText(failure).waitFor({ timeout: 10_000 }).then(() => true, () => false);
      expect(said, "the failure copy in the hint").toBe(true);
      expect(await fixture(page, (f) => f.status()?.failed)).toBe(true);
      expect(await fixture(page, (f) => f.snapshotNow())).toEqual({ ok: false, error: "QuotaExceededError" });
      expect(await line.textContent(), "no claim that it is kept").toBe("draft · this host doesn't keep drafts");

      await field(page).press("End");
      await field(page).pressSequentially(" · six men lost");
      expect(await field(page).inputValue(), "still editable").toBe("Scylla on one side, Charybdis on the other · six men lost");
      expect(await line.textContent(), "still no claim").toBe("draft · this host doesn't keep drafts");
      const stored = await fixture(page, (f) => f.list(f.accountKey()!));
      expect(stored.ok && stored.value.some((r) => JSON.stringify(r.value).includes("Charybdis")), "nothing of it was kept").toBe(false);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("commit measurement waits for native account restoration", async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let completion: Promise<void> | undefined;
    let result: "ok" | "error" | undefined;
    try {
      await signIn(page);
      await page.addInitScript(() => {
        const original = IDBObjectStore.prototype.getAll;
        const held = { started: false, reserved: false, restoreEntered: 0, snapshotCalls: 0, release: () => {} };
        Object.assign(window, { __accountRestoreHold: held });
        IDBObjectStore.prototype.getAll = function (...args: Parameters<typeof original>) {
          const request = Reflect.apply(original, this, args) as IDBRequest;
          const query = args[0];
          const lower = query instanceof IDBKeyRange ? query.lower : query;
          if (!held.reserved && this.name === "records" && Array.isArray(lower) &&
              String(lower[0]).startsWith("account:") && String(lower[1]).includes("odysseus-local")) {
            held.reserved = true;
            request.addEventListener("success", event => {
              event.stopImmediatePropagation();
              held.started = true;
              let released = false;
              held.release = () => {
                IDBObjectStore.prototype.getAll = original;
                if (!released) { released = true; request.onsuccess?.call(request, event); }
              };
            }, { once: true });
          }
          return request;
        };
      });
      await page.goto(origin);
      await until(page, "f.connected() && f.accountKey() !== null");
      await page.waitForFunction(() => (window as unknown as { __accountRestoreHold: { started: boolean } }).__accountRestoreHold.started);
      await page.evaluate(() => {
        const hold = (window as unknown as { __accountRestoreHold: { restoreEntered: number; snapshotCalls: number } }).__accountRestoreHold;
        const f = (window as unknown as { __local: Fixture }).__local;
        const restoring = f.restoring; const snapshot = f.snapshotNow;
        f.restoring = () => { hold.restoreEntered++; return restoring(); };
        f.snapshotNow = () => { hold.snapshotCalls++; return snapshot(); };
      });
      expect(await fixture(page, f => f.snapshotNow()), "the real snapshot still refuses before the account is bound")
        .toEqual({ ok: false, error: "PartitionRefusedError" });
      completion = committed(page).then(() => { result = "ok"; }, () => { result = "error"; });
      await page.waitForFunction(() => {
        const h = (window as unknown as { __accountRestoreHold: { restoreEntered: number; snapshotCalls: number } }).__accountRestoreHold;
        return h.restoreEntered > 0 || h.snapshotCalls > 1;
      });
      const calls = await page.evaluate(() => (window as unknown as { __accountRestoreHold: { snapshotCalls: number } }).__accountRestoreHold.snapshotCalls);
      expect(calls, "commit measurement must not dispatch a snapshot before native account restoration").toBe(1);
      expect(result, "measurement remains pending while the actual restoration read is held").toBeUndefined();
      await page.evaluate(() => (window as unknown as { __accountRestoreHold: { release(): void } }).__accountRestoreHold.release());
      await completion;
      expect(result, "restoration release permits the original committed snapshot").toBe("ok");
    } finally {
      await page.evaluate(() => (window as unknown as { __accountRestoreHold?: { release(): void } }).__accountRestoreHold?.release()).catch(() => {});
      await completion;
      await context.close();
    }
  }, 30_000);
});
