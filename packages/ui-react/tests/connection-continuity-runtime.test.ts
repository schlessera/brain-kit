import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
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
// and 1280px, in both themes, the test measures what the reader and the
// writer would notice, in the offline state and again after recovery.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Connection-continuity runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING connection-continuity runtime proof: no Chrome; drop/reconnect continuity is unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let port = 0;
let origin = "";
let sequence = 0;

const transcripts = new Map<string, SessionHistoryMessage[]>();
const titles = new Map<string, string>();
/** Held turns, by prompt. */
const gates = new Map<string, () => void>();
const advance = new Map<string, () => void>();

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
    getHistory: async (sessionId) => structuredClone(transcripts.get(sessionId) ?? []),
    async startTurn({ prompt, bridge, sessionId: resumed, signal, attachments }) {
      const sessionId = resumed ?? `odysseus-continuity-${++sequence}`;
      const title = prompt.replace(/^[^:]*:\s*/, "").split(" (")[0]!;
      if (!titles.has(sessionId)) titles.set(sessionId, title);
      bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: prompt, toolCalls: [], ...(attachments?.length ? { attachmentCount: attachments.length } : {}) });
      if (prompt.startsWith("Hold:")) {
        const opening = `Setting out: ${title}. ${LOG}\n\n`;
        const partial: SessionHistoryMessage = { role: "assistant", content: opening, toolCalls: [] };
        transcript.push(partial);
        bridge.emit({ type: "text_delta", sessionId, text: opening });
        await new Promise<void>((release) => {
          gates.set(prompt, release);
          advance.set(prompt, () => {
            partial.content += "Rowing again. ";
            bridge.emit({ type: "text_delta", sessionId, text: "Rowing again. " });
          });
        });
        if (signal.aborted) return;
        const end = `Landed: ${title}.`;
        partial.content += end;
        bridge.emit({ type: "text_delta", sessionId, text: end });
      } else {
        transcript.push({ role: "assistant", content: `Noted: ${title}.`, toolCalls: [] });
        bridge.emit({ type: "text_delta", sessionId, text: `Noted: ${title}.` });
      }
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
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
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
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
  app = await createApp({ config, staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 600_000 });
  listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 240_000);

afterEach(() => {
  for (const release of gates.values()) release();
  gates.clear();
  advance.clear();
});

afterAll(async () => {
  for (const release of gates.values()) release();
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Probe = {
  connected(): boolean;
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
    await Bun.sleep(100);
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
const cells: Cell[] = [
  { name: "320 phone, dark", theme: "dark", width: 320, height: 640 },
  { name: "320 phone, light", theme: "light", width: 320, height: 640 },
  { name: "1280 desktop, dark", theme: "dark", width: 1280, height: 800 },
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
  await composer(page).press("Enter");
}

/** Lets entrances, a resync and the save line settle: two frames after a quiet half-second. */
async function settle(page: Page) {
  await page.waitForTimeout(500);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function scene(cell: Cell): Promise<Scene> {
  const tag = `(${cell.name})`;
  const context = await browser!.newContext({ viewport: { width: cell.width, height: cell.height }, reducedMotion: "reduce" });
  const net: Net = { held: [], holdTracks: true, uploads: 0, sent: [] };
  // Keep the real browser offline apart from this one local host.
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.route("**/api/track-upload", (route) => {
    net.uploads++;
    if (net.holdTracks) net.held.push(route);
    else void route.continue();
  });
  await context.addInitScript((theme) => localStorage.setItem("odysseus-continuity:brain-theme", theme), cell.theme);
  await context.addInitScript(recorder);
  const page = await context.newPage();
  page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => {
    try { net.sent.push(String(JSON.parse(String(payload)).type)); } catch { net.sent.push("unreadable"); }
  }));
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.goto(origin);
  await until(page, "p?.connected() && p.draftsSupported() === true");
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme), "the cell's theme is the one drawn").toBe(cell.theme);

  // B runs out of view: a tracker where the width draws it (#950).
  await send(page, `Hold: Row through Scylla's strait ${tag}`);
  await until(page, "p.activeSessionId() !== null && p.streaming(p.activeSessionId())");
  const B = (await probe(page, (p) => p.activeSessionId()))!;
  await page.getByText("Setting out: Row through Scylla's strait").first().waitFor();
  await settle(page);
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
  await page.mouse.wheel(0, -600);
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
};
async function mark(page: Page) {
  await page.evaluate(() => {
    const field = document.querySelector("textarea[data-composer]")!;
    const column = document.querySelector("[data-reading-column]")!;
    const top = column.parentElement!.getBoundingClientRect().top;
    const nodes = [...column.children];
    const first = nodes.find((n) => n.getBoundingClientRect().bottom > top + 1)!;
    const images = [...column.querySelectorAll("img")];
    Object.assign(window, { __marks: { field, nodes, first, images } });
    // From here on, every composition and focus event is the drops' doing.
    (window as unknown as { __events: unknown[] }).__events.length = 0;
  });
}
function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const marks = (window as unknown as { __marks: { field: HTMLTextAreaElement; nodes: Element[]; first: Element; images: HTMLImageElement[] } }).__marks;
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
    };
  });
}

/** A drop as a phone sees one: the host's sockets and the in-flight upload cut, the browser offline. */
async function drop(s: Scene) {
  // The upload in flight fails first, before the page has seen anything else
  // of the drop: the order that cannot hide a failure behind a pause.
  const uploading = s.net.held.splice(0);
  for (const route of uploading) await route.abort("connectionreset").catch(() => {});
  if (uploading.length) await s.page.waitForFunction(() => !/uploading/.test(document.querySelector("[data-track-chip]")?.getAttribute("aria-label") ?? ""));
  server!.stop(true);
  await s.context.setOffline(true);
  await until(s.page, "p.wsStatus() !== 'connected' && p.vpnStatus() === 'unreachable'");
  await s.page.locator('[role="status"]', { hasText: "Connection lost" }).waitFor();
  await settle(s.page);
}

/** The network and the host come back; the app finds them on its own. */
async function recover(s: Scene) {
  listen();
  await s.context.setOffline(false);
  await until(s.page, "p.connected() && p.vpnStatus() === 'connected'");
  await s.page.locator('[role="status"]', { hasText: "Connection lost" }).waitFor({ state: "detached" });
  await settle(s.page);
}

/**
 * Node identity first: a replaced transcript also moves the field (the
 * replayed answer is no longer streaming), and that must not mask it.
 */
function same(label: string, now: Measure, base: Measure) {
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
  await settle(s.page);
  expect(await s.page.evaluate(() => {
    const marks = (window as unknown as { __marks: { nodes: Element[] } }).__marks;
    const column = document.querySelector("[data-reading-column]")!;
    return marks.nodes.at(-1)?.isConnected && column.children[1] === marks.nodes.at(-1);
  }), "recovered text and the terminal replay kept the original answer node").toBe(true);
  expect(await s.page.locator('[data-row-half="right"] [data-pill]').count(), "the queued follow-up was taken").toBe(0);
}

describe.skipIf(!executablePath)("repeated connection drops in the mounted app", () => {
  for (const cell of cells) {
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
          await recover(s);
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
