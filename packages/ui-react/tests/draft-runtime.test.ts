import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { DraftListResponse, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Per-session drafts end to end (#951, D52 §5), on the real public ChatPage
// in real Chrome against the real app and its #979 draft routes. Two browser
// contexts are two devices of the same operator. A draft is saved only when
// the host says so; a reload and the other device restore its text and
// image; a dirty edit meeting the other device's newer save is a conflict
// that keeps both; a send consumes exactly the revision it named, and
// newer edits stay. Keyless: the backend is scripted, and the first turn
// waits until the test lets it finish.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Draft runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING draft runtime proof: no Chrome; drafts are unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "";
let sequence = 0;
const transcripts = new Map<string, SessionHistoryMessage[]>();
const gates = new Map<string, () => void>();
const prompts: string[] = [];

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
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set(rgb, y * (size * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const HARBOUR = png([30, 90, 160]);

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Draft fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-drafts-"));
  const brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/draft-runtime-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Draft client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  const backend: AgentBackend = {
    id: "drafts-scripted", capabilities: { resume: true, permissions: false, thinking: false, attachments: true, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "drafts-scripted", label: "Local fixture" }],
    listSessions: async () => [...transcripts.keys()].map((id) => ({ id, title: "Harbours of Ithaca", createdAt: 1, lastActiveAt: Date.now(), totalCostUsd: 0, numTurns: 1 })),
    getHistory: async (sessionId) => structuredClone(transcripts.get(sessionId) ?? []),
    async startTurn({ prompt, bridge, sessionId: resumed }) {
      const sessionId = resumed ?? `odysseus-harbour-${++sequence}`;
      prompts.push(prompt);
      bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: prompt, toolCalls: [] });
      if (prompt.startsWith("Hold:")) await new Promise<void>((release) => gates.set(prompt, release));
      transcript.push({ role: "assistant", content: "Phorcys' harbour, under the olive tree.", toolCalls: [] });
      bridge.emit({ type: "text_delta", sessionId, text: "Phorcys' harbour, under the olive tree." });
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }), staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 60_000 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  for (const release of gates.values()) release();
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type View = { draftId: string; text: string; images: number; revision: number | null; conflict: boolean };
type Fixture = {
  connected(): boolean;
  supported(): boolean | null;
  activeSessionId(): string | null;
  view(): View;
  unbound(): string[];
  sends(): Array<{ requestId: string; state: string; draftRef: { draftId: string; revision: number } | null }>;
  lastAssistant(): string | null;
  resume(sessionId: string): void;
  newChat(): void;
  away(): void;
  back(): void;
};

const fixture = <T,>(page: Page, fn: (f: Fixture) => T) => page.evaluate(`(${fn.toString()})(window.__drafts)`) as Promise<T>;
async function until(page: Page, predicate: string, timeout = 15_000) {
  await page.waitForFunction(`(() => { const f = window.__drafts; return ${predicate}; })()`, undefined, { timeout });
}

/** What the host keeps, read past the UI. */
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
    await Bun.sleep(100);
  }
}

async function release(prompt: string) {
  for (let i = 0; i < 200 && !gates.has(prompt); i++) await Bun.sleep(25);
  const gate = gates.get(prompt);
  if (!gate) throw new Error(`No turn is waiting on ${prompt}`);
  gates.delete(prompt);
  gate();
}

const wide = (options: BrowserContextOptions) => (options.viewport?.width ?? 0) >= 1280;

async function device(options: BrowserContextOptions, theme: "dark" | "light"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext(options);
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript((t) => {
    document.documentElement.dataset.theme = t;
    if (t === "dark") document.documentElement.classList.add("dark");
  }, theme);
  const page = await context.newPage();
  await page.goto(origin);
  await until(page, "f?.connected() && f.supported() === true");
  return { context, page };
}

const press = async (page: Page, options: BrowserContextOptions, name: string) => {
  const target = page.getByRole("button", { name, exact: true }).first();
  if (options.hasTouch) await target.tap();
  else await target.click();
};

const runs: Array<{ name: string; theme: "dark" | "light"; options: BrowserContextOptions }> = [
  { name: "390 phone, dark, coarse pointer", theme: "dark", options: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  { name: "900 desktop, light, reduced motion", theme: "light", options: { viewport: { width: 900, height: 700 }, reducedMotion: "reduce" } },
  { name: "1440 desktop, dark", theme: "dark", options: { viewport: { width: 1440, height: 900 } } },
];

describe.skipIf(!executablePath)("mounted per-session drafts", () => {
  for (const run of runs) {
    test(`${run.name}: saved on the host, restored after reload and on another device, conflicts kept, sends consume their revision`, async () => {
      const tag = `(${run.name})`;
      const a = await device(run.options, run.theme);
      let b: Awaited<ReturnType<typeof device>> | undefined;
      const composer = (page: Page) => page.locator("textarea.bk-composer");
      const line = (page: Page) => page.locator("[data-draft-save]");
      try {
        // An unbound draft, saved, then sent: the message names its revision.
        const first = `Hold: Which harbour on Ithaca is safest? ${tag}`;
        await composer(a.page).fill(first);
        await line(a.page).and(a.page.locator('[data-draft-save="saved"]')).waitFor();
        expect(await line(a.page).textContent()).toBe("draft · saved");
        const unboundId = (await fixture(a.page, (f) => f.view().draftId));
        await hostUntil((d) => d.some((x) => x.draftId === unboundId && x.sessionId === null && x.preview === first));
        await composer(a.page).press("Enter");
        await until(a.page, "f.activeSessionId() !== null");
        const session = (await fixture(a.page, (f) => f.activeSessionId()))!;
        expect(await fixture(a.page, (f) => f.sends().at(-1)?.draftRef?.draftId)).toBe(unboundId);
        // Accepted: the host consumed exactly that revision.
        await hostUntil((d) => !d.some((x) => x.draftId === unboundId));
        expect(await composer(a.page).inputValue()).toBe("");

        // Typed while the first turn still runs: this session's next revision.
        const later = `Also ask about the harbour fees ${tag}`;
        await composer(a.page).fill(later);
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        await hostUntil((d) => d.some((x) => x.sessionId === session && x.preview === later));
        await release(first);
        await until(a.page, `f.lastAssistant() === "Phorcys' harbour, under the olive tree."`);

        // An image joins it; the host stores the bytes before it says saved.
        await a.page.locator('input[type="file"][accept="image/*"]:not([capture])').setInputFiles({ name: "harbour.png", mimeType: "image/png", buffer: HARBOUR });
        await until(a.page, "f.view().images === 1");
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        await hostUntil((d) => d.some((x) => x.sessionId === session && x.attachmentCount === 1));

        // New chat: an empty composer, the session's draft kept.
        await press(a.page, run.options, wide(run.options) ? "New conversation" : "New chat");
        await until(a.page, "f.activeSessionId() === null");
        expect(await composer(a.page).inputValue()).toBe("");
        const letter = `Letter to Penelope ${tag}`;
        await composer(a.page).fill(letter);
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        // Repeated New chats from here leave the letter and add nothing.
        await fixture(a.page, (f) => { f.newChat(); f.newChat(); });
        expect(await composer(a.page).inputValue()).toBe("");
        expect(await fixture(a.page, (f) => f.unbound())).toEqual([letter]);

        // Back to the session: its own text and image, nothing of the letter.
        await a.page.evaluate((s) => (window as unknown as { __drafts: Fixture }).__drafts.resume(s), session);
        await until(a.page, `f.activeSessionId() === ${JSON.stringify(session)}`);
        expect(await composer(a.page).inputValue()).toBe(later);
        expect(await a.page.locator("[data-composer] img").count()).toBe(1);
        // Unmounted and mounted again, as Actions does: still there.
        await fixture(a.page, (f) => f.away());
        await a.page.locator("[data-away]").waitFor();
        await fixture(a.page, (f) => f.back());
        await composer(a.page).waitFor();
        expect(await composer(a.page).inputValue()).toBe(later);
        expect(await a.page.locator("[data-composer] img").count()).toBe(1);

        // A reload: everything here was in memory; the host brings it back.
        await a.page.reload();
        await until(a.page, "f?.connected() && f.supported() === true");
        await until(a.page, `f.unbound().length === 1`);
        expect(await fixture(a.page, (f) => f.unbound())).toEqual([letter]);
        await a.page.evaluate((s) => (window as unknown as { __drafts: Fixture }).__drafts.resume(s), session);
        await until(a.page, `f.view().text === ${JSON.stringify(later)} && f.view().images === 1`);
        expect(await composer(a.page).inputValue()).toBe(later);
        expect(await line(a.page).textContent()).toBe("draft · saved");

        // The other device: the same text and image, and the letter's entry.
        b = await device(run.options, run.theme);
        await until(b.page, `f.unbound().length === 1`);
        await b.page.evaluate((s) => (window as unknown as { __drafts: Fixture }).__drafts.resume(s), session);
        await until(b.page, `f.view().text === ${JSON.stringify(later)} && f.view().images === 1`);
        expect(await composer(b.page).inputValue()).toBe(later);

        // Both edit: the other device saves first. This device's dirty edit
        // is never overwritten; the host refuses it and the reader chooses.
        const theirs = `Ask Eumaeus about the harbour fees ${tag}`;
        await composer(b.page).fill(theirs);
        await b.page.locator('[data-draft-save="saved"]').waitFor();
        const mine = `Ask Telemachus about the harbour fees ${tag}`;
        await composer(a.page).fill(mine);
        await a.page.locator('[data-draft-save="conflict"]').waitFor();
        expect(await line(a.page).textContent()).toBe("draft changed on another device·Compare");
        expect(await composer(a.page).inputValue()).toBe(mine);
        await press(a.page, run.options, "Compare drafts");
        const sheet = a.page.locator("[data-compare-drafts]");
        await sheet.waitFor();
        expect(await sheet.locator('[data-compare-side="this"] p').textContent()).toBe(mine);
        expect(await sheet.locator('[data-compare-side="other"] p').textContent()).toBe(theirs);
        await press(a.page, run.options, "Keep both");
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        await hostUntil((d) => d.some((x) => x.sessionId === session && x.preview === mine) && d.some((x) => x.sessionId === null && x.preview === theirs));
        expect(await fixture(a.page, (f) => f.unbound().sort())).toEqual([theirs, letter].sort());

        // Offline: kept, and never called saved, until the host answers again.
        await a.context.route("**/api/drafts/**", (route) => route.abort());
        const offline = `${mine}, and the wind ${tag}`;
        await composer(a.page).fill(offline);
        await a.page.locator('[data-draft-save="unsaved"]').waitFor({ timeout: 20_000 });
        expect(await line(a.page).textContent()).toBe("draft · not saved yet");
        await a.context.unroute("**/api/drafts/**");
        await a.page.locator('[data-draft-save="saved"]').waitFor({ timeout: 20_000 });

        // Sent: the host consumes the session's draft, and nothing recreates it.
        await composer(a.page).press("Enter");
        await hostUntil((d) => !d.some((x) => x.sessionId === session));
        await Bun.sleep(1500);
        expect((await hostDrafts()).some((x) => x.sessionId === session)).toBe(false);
        expect(await composer(a.page).inputValue()).toBe("");
        expect(prompts.filter((p) => p === offline)).toHaveLength(1);
      } finally {
        await b?.context.close();
        await a.context.close();
        for (const d of await hostDrafts()) await fetch(`${origin}/api/drafts/${d.draftId}`, { method: "DELETE", headers: { origin, "if-match": String(d.revision) } });
      }
    }, 120_000);
  }
});
