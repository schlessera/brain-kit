import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
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

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Local work fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-local-work-"));
  brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/local-work-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Local work client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  await writeFile(resolve(scratch, "shroud.png"), SHROUD);
  passwordHash = await Bun.password.hash(PASSWORD);
  host = await startHost("ithaca.db");
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await stopHost(host);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

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

async function signIn(context: BrowserContext) {
  const res = await context.request.post(`${origin}/api/auth/login`, { data: { password: PASSWORD }, headers: { origin } });
  expect(res.status()).toBe(200);
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

describe.skipIf(!executablePath)("device-local work context (#1014)", () => {
  test("a draft with a selection, an image and review text survives a reload; the transcript returns to its place", async () => {
    const context = await browser!.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    try {
      await signIn(context);
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
      await signIn(context);
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
      await signIn(context);
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
      await signIn(context);
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
        held.push(tx);
        w.__hold.held = held.length;
        const store = tx.objectStore("records");
        // Issued first, so every write the caller issues next runs, and succeeds, before the spin goes on.
        const spin = () => { if (!done) store.get(["held", "held"]).onsuccess = spin; };
        spin();
        return tx;
      };
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...a: Parameters<IDBObjectStore["put"]>) {
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
  const hold = (page: Page) => page.evaluate(() => (window as unknown as { __hold: { held: number; puts: number } }).__hold);
  async function startSnapshot(page: Page, text: string) {
    await page.evaluate((text) => {
      const w = window as unknown as { __local: Fixture; __snap: { done: boolean; result?: Outcome } };
      w.__snap = { done: false };
      void w.__local.editAndSnapshot(text).then((result) => { w.__snap = { done: true, result }; });
    }, text);
  }
  const snap = (page: Page) => page.evaluate(() => (window as unknown as { __snap: { done: boolean; result?: Outcome } }).__snap);

  test("snapshotNow resolves only once its transaction has committed, and rejects when it aborts", async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await signIn(context);
      await page.goto(origin);
      await until(page, "f.connected() && f.accountKey() !== null");
      await committed(page);

      // Its own transaction, its writes done, not yet committed.
      await armHold(page, "release");
      await startSnapshot(page, "The raft, and Calypso's island behind it");
      await page.waitForFunction(() => (window as unknown as { __hold: { puts: number } }).__hold.puts > 0, undefined, { timeout: 5_000 });
      await page.waitForTimeout(500);
      expect((await hold(page)).held, "its writes are in a held transaction").toBeGreaterThan(0);
      expect((await snap(page)).done, "not resolved while its transaction is open").toBe(false);
      await page.evaluate(() => (window as unknown as { __hold: { finish: () => void } }).__hold.finish());
      await page.waitForFunction(() => (window as unknown as { __snap: { done: boolean } }).__snap.done, undefined, { timeout: 5_000 });
      expect((await snap(page)).result).toEqual({ ok: true, value: undefined });
      const stored = await fixture(page, (f) => f.list(f.accountKey()!));
      expect(stored.ok && stored.value.some((r) => JSON.stringify(r.value).includes("Calypso")), "committed when it resolved").toBe(true);

      // The same, aborted after its writes succeeded: no receipt, and the failure is said.
      await armHold(page, "abort");
      await startSnapshot(page, "Ogygia, seven years");
      await page.waitForFunction(() => (window as unknown as { __hold: { puts: number } }).__hold.puts > 0, undefined, { timeout: 5_000 });
      await page.evaluate(() => (window as unknown as { __hold: { finish: () => void } }).__hold.finish());
      await page.waitForFunction(() => (window as unknown as { __snap: { done: boolean } }).__snap.done, undefined, { timeout: 5_000 });
      expect((await snap(page)).result, "an aborted snapshot rejects").toEqual({ ok: false, error: "AbortError" });
      expect(await fixture(page, (f) => f.status()?.failed)).toBe(true);
      const after = await fixture(page, (f) => f.list(f.accountKey()!));
      expect(after.ok && after.value.some((r) => JSON.stringify(r.value).includes("Ogygia")), "nothing of it was kept").toBe(false);
    } finally {
      await context.close();
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
      await signIn(context);
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
});
