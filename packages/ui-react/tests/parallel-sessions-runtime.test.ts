import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { ClientMessage, DraftListResponse, ServerMessage, SessionHistoryMessage, SessionRecovery } from "@schlessera/brain-ui-sdk/protocol";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Parallel sessions end to end (#953, the #929 epic's integrated proof): the
// whole app as a hosting shell composes it (AppShell, Chat, Actions, Graph)
// in real Chrome against the real host, its recovery route (#964) and its
// draft routes (#979). Every activation is a real click or tap on what is on
// screen; the page's probe only reads state. Keyless: the backend is
// scripted, every turn streams real text, and a held turn waits until the
// test releases it.
//
// What each test proves, by D52's sections:
// - §4: work left in A and B is tracked where the width draws it, through
//   success, failure, a queued follow-up, an approval and all four question
//   forms; more than two collapse into a summary; a reconnect, a reload and
//   a host restart keep every tracker, and nothing unfinished or
//   unavailable ever reads done. A tracker clears only once its latest turn
//   is on screen: selecting it, a panel over Chat and a scrolled-up
//   transcript do not. Each change is announced once, never by a ticking
//   age or a replay.
// - §5: each session's own text and image come back through every New chat,
//   session and destination entry point, a remount, a reload, a host
//   restart and another device; a save the host refuses (offline, too
//   large, full) is never called saved and keeps the words; New chat opens
//   empty with no confirmation, and leaving a streaming session aborts
//   nothing. A new chat holding only a track the real host read stays a
//   Draft entry through New chat, and sends nothing (#1112). While a track
//   is staged out of view a reload asks Chromium's leave confirmation, and
//   once it is sent or removed neither a reload nor a waiting update asks
//   (#1150).
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Parallel-sessions runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING parallel-sessions runtime proof: no Chrome; #929 is unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let config: ReturnType<typeof resolveServerConfig> | undefined;
let backend: AgentBackend | undefined;
let assets = "";
let port = 0;
let origin = "";
let sequence = 0;

const transcripts = new Map<string, SessionHistoryMessage[]>();
const titles = new Map<string, string>();
/** Held turns, by prompt: release with `ok` or `fail`. */
const gates = new Map<string, (how: "ok" | "fail") => void>();
/** Every turn the host started, and every one whose signal fired. */
const started: Array<{ sessionId: string; prompt: string }> = [];
const aborted: string[] = [];
/** What the backend's tools were answered with, by prompt. */
const answers = new Map<string, unknown>();

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

const ASKS = {
  "Ask list": { tool: "mcp__brain-ui__ask_user_list", input: { prompt: "Choose raft supplies", items: [{ id: "rope", label: "Rope" }], scale: [{ label: "Pack" }, { label: "Leave" }], allowSkip: false, notes: false } },
  "Ask rank": { tool: "mcp__brain-ui__ask_user_rank", input: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] } },
  "Ask form": { tool: "mcp__brain-ui__ask_user_form", input: { prompt: "Record raft supplies", nodes: [{ id: "note", kind: "text", prompt: "Supply note", required: true }] } },
  "Ask user": { tool: "mcp__brain-ui__ask_user", input: { questions: [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor’s court" }] }] } },
} as const;
type AskKind = keyof typeof ASKS;

/** The scripted backend: the prompt's first word says what the turn does. */
function scriptedBackend(): AgentBackend {
  return {
    id: "parallel-scripted",
    capabilities: { resume: true, permissions: true, thinking: false, attachments: true, askUser: true, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "parallel-scripted", label: "Local fixture" }],
    listSessions: async () => [...transcripts.keys()].map((id, i) => ({ id, title: titles.get(id) ?? "Odysseus", createdAt: 1 + i, lastActiveAt: Date.now(), totalCostUsd: 0, numTurns: 1 })),
    getHistory: async (sessionId) => structuredClone(transcripts.get(sessionId) ?? []),
    async startTurn({ prompt, bridge, sessionId: resumed, signal }) {
      signal.addEventListener("abort", () => aborted.push(prompt), { once: true });
      const sessionId = resumed ?? `odysseus-parallel-${++sequence}`;
      started.push({ sessionId, prompt });
      const title = prompt.replace(/^[^:]*:\s*/, "").split(" (")[0]!;
      if (!titles.has(sessionId)) titles.set(sessionId, title);
      // A first message the host has not named a session for yet.
      if (prompt.startsWith("Late:")) await new Promise<"ok" | "fail">((release) => gates.set(prompt, release));
      bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: prompt, toolCalls: [] });
      const kind = prompt.split(":")[0]!;
      const finish = (text: string, outcome: "success" | "error") => {
        transcript.push({ role: "assistant", content: text, toolCalls: [] });
        bridge.emit({ type: "text_delta", sessionId, text });
        bridge.emit({ type: "result", sessionId, outcome, durationMs: 0, numTurns: 1, isError: outcome === "error" });
      };
      if (kind === "Hold") {
        // A long answer streams first, so the transcript can be scrolled
        // while the turn is still running. Like a real backend's transcript,
        // the history holds what was said so far.
        const opening = `Setting out: ${title}. ${LOG}\n\n`;
        const partial: SessionHistoryMessage = { role: "assistant", content: opening, toolCalls: [] };
        transcript.push(partial);
        bridge.emit({ type: "text_delta", sessionId, text: opening });
        const how = await new Promise<"ok" | "fail">((release) => gates.set(prompt, release));
        if (signal.aborted) return;
        const end = how === "fail" ? "The mast cracked in the storm." : `Landed: ${title}.`;
        partial.content = opening + end;
        bridge.emit({ type: "text_delta", sessionId, text: end });
        bridge.emit({ type: "result", sessionId, outcome: how === "fail" ? "error" : "success", durationMs: 0, numTurns: 1, isError: how === "fail" });
        return;
      }
      if (kind === "Approve") {
        const toolUseId = `wax-${sequence}`;
        const decision = await bridge.requestPermission({ toolUseId, toolName: "Bash", input: { command: "seal --ears crew" }, kind: "command", description: "Seal the crew's ears with wax." });
        answers.set(prompt, decision.behavior);
        bridge.emit({ type: "tool_result", sessionId, toolUseId, output: decision.behavior === "allow" ? "Ears sealed." : "Denied by user", isError: decision.behavior !== "allow" });
        finish(`Sealed: ${title}.`, "success");
        return;
      }
      if (kind in ASKS) {
        const ask = ASKS[kind as AskKind];
        const requestId = `toolu_${kind.replace(" ", "_")}_${sequence}`;
        bridge.emit({ type: "tool_use_start", sessionId, toolUseId: requestId, toolName: ask.tool });
        bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: requestId, toolName: ask.tool, input: ask.input });
        transcript.push({ role: "assistant", content: "", toolCalls: [{ id: requestId, name: ask.tool, input: ask.input } as SessionHistoryMessage["toolCalls"][number]], parts: [{ kind: "tool", toolIndex: 0 }] });
        try {
          const result = kind === "Ask user" ? await bridge.askUser!(requestId, ASKS["Ask user"].input.questions as never)
            : kind === "Ask list" ? await bridge.askUserList!(requestId, ASKS["Ask list"].input as never)
            : kind === "Ask rank" ? await bridge.askUserRank!(requestId, ASKS["Ask rank"].input as never)
            : await bridge.askUserForm!(requestId, askUserFormSpec(ASKS["Ask form"].input as never));
          answers.set(prompt, result);
          bridge.emit({ type: "tool_result", sessionId, toolUseId: requestId, output: JSON.stringify(result), isError: false });
          finish(`Answered: ${title}.`, "success");
        } catch (error) {
          bridge.emit({ type: "tool_result", sessionId, toolUseId: requestId, output: (error as Error).message, isError: true });
          bridge.emit({ type: "result", sessionId, outcome: "cancelled", durationMs: 0, numTurns: 1, isError: false });
        }
        return;
      }
      finish(`Noted: ${title}.`, "success");
    },
  };
}

async function startHost() {
  app = await createApp({ config: config!, staticRoot: assets, registry: createStaticBackendRegistry([backend!], backend!.id), observability: createRecordingObservability(), turnTimeoutMs: 120_000 });
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket: app.websocket });
  port = server.port!;
  origin = `http://127.0.0.1:${port}`;
}

/** A dropped connection: the same host, every socket closed, then listening again. */
async function dropConnections() {
  server!.stop(true);
  await Bun.sleep(200);
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app!.fetch, websocket: app!.websocket });
}

/** A normal host restart: the process's turns end, its database stays. */
async function restartHost() {
  server!.stop(true);
  app!.cancelActiveTurns();
  await app!.close();
  for (const release of gates.values()) release("ok");
  gates.clear();
  await startHost();
}

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Parallel-sessions fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-parallel-"));
  const brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:{entry:"client.js",chunk:"[name]-[hash].js"},splitting:true}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/parallel-sessions-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Parallel-sessions client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  backend = scriptedBackend();
  config = resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0", MAX_CONCURRENT_SESSIONS: "12" });
  await startHost();
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 240_000);

afterAll(async () => {
  for (const release of gates.values()) release("ok");
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type View = { sessionId: string; state: string; pendingKind: string | null; cleared: boolean; turnId: string | null; settled: boolean };
type Probe = {
  connected(): boolean;
  draftsSupported(): boolean | null;
  activeSessionId(): string | null;
  view(): string;
  views(): View[];
  records(): Record<string, { seen: { turnId: string; basis: string } | null }>;
  spoken(): string[];
  draft(): { text: string; images: number; sessionId: string | null };
  unbound(): string[];
  transcript(sessionId: string | null): string[];
  streaming(sessionId: string): boolean;
  staged(): boolean;
};
const probe = <T,>(page: Page, fn: (p: Probe) => T) => page.evaluate(`(${fn.toString()})(window.__parallel)`) as Promise<T>;
async function until(page: Page, predicate: string, timeout = 15_000) {
  try {
    await page.waitForFunction(`(() => { const p = window.__parallel; return ${predicate}; })()`, undefined, { timeout });
  } catch (error) {
    console.error(`never held: ${predicate}`, JSON.stringify(await page.evaluate("({ views: window.__parallel?.views(), active: window.__parallel?.activeSessionId(), draft: window.__parallel?.draft() })").catch(() => null)));
    throw error;
  }
}

async function release(prompt: string, how: "ok" | "fail" = "ok") {
  for (let i = 0; i < 200 && !gates.has(prompt); i++) await Bun.sleep(25);
  const gate = gates.get(prompt);
  if (!gate) throw new Error(`No turn is waiting on ${prompt}`);
  gates.delete(prompt);
  gate(how);
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
async function clearHostDrafts() {
  for (const d of await hostDrafts()) await fetch(`${origin}/api/drafts/${d.draftId}`, { method: "DELETE", headers: { origin, "if-match": String(d.revision) } });
}

type Run = { name: string; theme: "dark" | "light"; options: BrowserContextOptions };
const runs: Run[] = [
  { name: "390 phone, light, coarse pointer, reduced motion", theme: "light", options: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" } },
  { name: "1279 desktop, dark, fine pointer", theme: "dark", options: { viewport: { width: 1279, height: 800 } } },
  { name: "1440 desktop, light, fine pointer, reduced motion", theme: "light", options: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } },
];
const wide = (run: Run) => (run.options.viewport?.width ?? 0) >= 1280;
const phone = (run: Run) => (run.options.viewport?.width ?? 0) < 480;

/**
 * Runs in the page before the app (#1150): a browser with an update waiting,
 * which `window.__worker.takeover()` installs and hands control to, and a
 * count of the documents this tab has loaded, so a reload is observed rather
 * than inferred.
 */
function waitingWorker() {
  const loads = Number(sessionStorage.getItem("odysseus-loads") ?? 0) + 1;
  sessionStorage.setItem("odysseus-loads", String(loads));
  const worker = Object.assign(new EventTarget(), { state: "installing" });
  const registration = Object.assign(new EventTarget(), { installing: worker });
  const container = Object.assign(new EventTarget(), {
    controller: {} as object | null,
    register: async () => registration,
    takeover() {
      worker.state = "installed";
      worker.dispatchEvent(new Event("statechange"));
      container.controller = worker;
      container.dispatchEvent(new Event("controllerchange"));
    },
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  Object.assign(window, { __worker: container, __loads: loads });
}

type ApprovalInput = { type: string; target: string | null; at: number; node: number | null; connected: boolean; y: number | null };
type ApprovalFrame = { event: "framesent" | "framereceived"; socket: number; at: number; frame: ClientMessage | ServerMessage };
type Device = { context: BrowserContext; page: Page; dialogs: string[]; sockets: string[]; approvals: ApprovalFrame[] };
async function device(run: Run, opts: { clock?: boolean; update?: boolean } = {}): Promise<Device> {
  const context = await browser!.newContext(run.options);
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  // The whole app applies the root's stored theme to the document, so the
  // run's theme is stored under the fixture root's prefix before it loads.
  await context.addInitScript((theme) => {
    localStorage.setItem("odysseus-parallel:brain-theme", theme);
  }, run.theme);
  if (opts.update) await context.addInitScript(waitingWorker);
  const page = await context.newPage();
  // A page clock the test can move forward; it runs in real time otherwise.
  if (opts.clock) await page.clock.install();
  const dialogs: string[] = [];
  // Every socket the page opens, so a reconnect is observed rather than inferred.
  const sockets: string[] = [];
  const approvals: ApprovalFrame[] = [];
  page.on("websocket", (ws) => {
    const socket = sockets.push(ws.url()) - 1;
    const record = (event: ApprovalFrame["event"], payload: string | Buffer) => {
      const frame = JSON.parse(String(payload)) as ClientMessage | ServerMessage;
      if (["tool_approval_request", "tool_approval", "tool_denial", "tool_resolution", "tool_result", "result", "error"].includes(frame.type)) approvals.push({ event, socket, at: Date.now(), frame });
    };
    ws.on("framesent", ({ payload }) => record("framesent", payload));
    ws.on("framereceived", ({ payload }) => record("framereceived", payload));
  });
  // A tap may return without a click. Capture its input events before page
  // load, without adding a synchronization point before the action (#1217).
  await page.addInitScript(() => {
    const events: ApprovalInput[] = [];
    const nodes = new WeakMap<Element, number>();
    let sequence = 0;
    Object.assign(window, { __approvalTouches: events });
    for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "click"]) document.addEventListener(type, (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-approval-card]")) {
        const control = target.closest("button") ?? target;
        if (!nodes.has(control)) nodes.set(control, ++sequence);
        events.push({ type, target: control.textContent, at: Date.now(), node: nodes.get(control)!,
          connected: control.isConnected, y: control.getBoundingClientRect().y });
      }
    }, true);
  });
  // A native confirm, alert or prompt is recorded and refused: none may
  // appear. A leave confirmation is recorded by its type, and refused too:
  // the page stays (#1150).
  page.on("dialog", (dialog) => { dialogs.push(dialog.type() === "beforeunload" ? "beforeunload" : dialog.message()); void dialog.dismiss(); });
  await page.goto(opts.update ? `${origin}/?update` : origin);
  await until(page, "p?.connected() && p.draftsSupported() === true");
  expect(await page.evaluate(() => document.documentElement.dataset.theme), "the run's theme is the one drawn").toBe(run.theme);
  return { context, page, dialogs, sockets, approvals };
}

/** A real tap under a coarse pointer, a real click otherwise; Playwright waits until the control is at rest (#992). */
async function press(run: Run, target: Locator) {
  await target.waitFor({ state: "visible" });
  if (run.options.hasTouch) await target.tap();
  else await target.click();
}
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).first();
const composer = (page: Page) => page.locator("textarea[data-composer]");
/** No modal of the app's own asks anything either. */
const confirmations = (page: Page) => page.locator('[role="alertdialog"]').count();

/** New chat from where the width draws it: the overlay disc below 1280, the pane's New conversation from 1280. */
async function newChat(run: Run, page: Page) {
  await press(run, button(page, wide(run) ? "New conversation" : "New chat"));
  await until(page, "p.activeSessionId() === null");
}

/** Sends what the composer holds, with the keyboard's Enter (or the send button on a phone). */
async function send(run: Run, page: Page, text: string) {
  await composer(page).fill(text);
  if (phone(run)) await press(run, button(page, "Send"));
  else await composer(page).press("Enter");
}

/** Where a session's tracker is drawn: the left half of the row below 1280, the pane's Working group from 1280. */
function trackerControl(run: Run, page: Page, sessionId: string) {
  return wide(run)
    ? page.locator(`section[data-sessions-pane] [data-working-row][data-session="${sessionId}"] [role="button"]`)
    : page.locator(`[data-row-half="left"] [data-session-strip] [data-session="${sessionId}"] [role="button"]`);
}
/** The trackers drawn now, as session ids, in order. */
async function drawn(run: Run, page: Page) {
  const sel = wide(run) ? "section[data-sessions-pane] [data-working-row]" : '[data-row-half="left"] [data-session-strip] [data-session]';
  return page.locator(sel).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.session!));
}
/** Opens a session's tracker by pressing it where it is drawn, through the summary's sheet when it is folded there. */
async function openTracker(run: Run, page: Page, sessionId: string) {
  const direct = trackerControl(run, page, sessionId);
  if (await direct.count()) return press(run, direct.first());
  await press(run, page.locator('[data-row-half="left"] [data-strip-summary]').first());
  await press(run, page.locator(`[data-working-sheet] [data-session="${sessionId}"] [role="button"]`).first());
}
/** Opens a session through the Sessions destination's own row: the drawer below 1280, the pane from 1280. */
async function openFromSessions(run: Run, page: Page, sessionId: string) {
  if (!wide(run)) await press(run, page.getByRole("tab", { name: /^Sessions/ }).locator("visible=true").first());
  await press(run, page.locator(`[data-session-row][data-session="${sessionId}"] [data-session-main] [role="button"], [data-working-row][data-session="${sessionId}"] [role="button"]`).locator("visible=true").first());
  await until(page, `p.activeSessionId() === ${JSON.stringify(sessionId)}`);
}

/**
 * The reader scrolls the transcript up: Chromium's own scroll gesture, by
 * touch under a coarse pointer and by mouse wheel otherwise, through the
 * input pipeline rather than a scrollTop write.
 */
async function scrollUp(run: Run, page: Page) {
  // The transcript's scroller, as it is drawn: the gesture starts at its middle.
  const box = await page.locator("[data-reading-column]").evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    if (!run.options.hasTouch) {
      await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(box.x), y: Math.round(box.y), yDistance: 4000, speed: 6000, gestureSourceType: "mouse" });
      return;
    }
    // A finger dragging the transcript down, a few times.
    for (let swipe = 0; swipe < 3; swipe++) {
      const x = Math.round(box.x);
      let y = Math.round(box.y - 120);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 0; step < 12; step++) {
        y += 20;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } finally { await cdp.detach(); }
}

/** No session reads done while its work is unfinished or unknown: the pill's word and the probe's state. */
async function neverDone(run: Run, page: Page, sessionIds: string[]) {
  const views = await probe(page, (p) => p.views());
  for (const id of sessionIds) {
    const v = views.find((x) => x.sessionId === id);
    expect(v?.state, `${id} is not done`).not.toBe("done");
  }
  const words = await page.locator(wide(run) ? "section[data-sessions-pane] [data-working-row] [role=button]" : '[data-row-half="left"] [data-session-strip] [role="button"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  for (const id of sessionIds) {
    const title = titles.get(id)!;
    for (const w of words.filter((x) => x.startsWith(title))) expect(w, `${title}'s pill`).not.toMatch(/, done/);
  }
}

describe.skipIf(!executablePath)("mounted parallel sessions", () => {
  for (const run of runs) {
    test(`${run.name}: A and B stream side by side; trackers follow success, failure and a queued follow-up, and clear only once seen`, async () => {
      const tag = `(${run.name})`;
      const a = await device(run, { clock: true });
      const pa = `Hold: Sail past the Sirens ${tag}`;
      const pb = `Hold: Row through Scylla's strait ${tag}`;
      const draftA = `Hold: Then bind me to the mast ${tag}`;
      const pc = `Hold: Row on to Thrinacia ${tag}`;
      const state = (id: string) => `p.views().find((v) => v.sessionId === ${JSON.stringify(id)})`;
      try {
        // A streams in the session in view: nothing is tracked while it is watched.
        await send(run, a.page, pa);
        await until(a.page, "p.activeSessionId() !== null && p.streaming(p.activeSessionId())");
        const A = (await probe(a.page, (p) => p.activeSessionId()))!;
        await a.page.getByText("Setting out: Sail past the Sirens").first().waitFor();
        expect(await probe(a.page, (p) => p.views().length), "a watched session is not tracked").toBe(0);

        // A's own unsent words and image, typed while it streams, saved on the host.
        await composer(a.page).fill(draftA);
        await a.page.locator('input[type="file"][accept="image/*"]:not([capture])').setInputFiles({ name: "sail.png", mimeType: "image/png", buffer: SAIL });
        await until(a.page, "p.draft().images === 1");
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        await hostUntil((d) => d.some((x) => x.sessionId === A && x.attachmentCount === 1 && x.preview === draftA));

        // Leaving A mid-stream: an empty composer, A tracked as running, and
        // neither a confirmation nor an abort.
        await newChat(run, a.page);
        expect(await composer(a.page).inputValue(), "New chat opens empty").toBe("");
        expect(await a.page.locator("[data-composer] img").count()).toBe(0);
        // Once the host has answered for it and the session list has been
        // read again (its lastActiveAt is newer than the leave), A is still
        // not done: it is running.
        await until(a.page, `${state(A)}?.settled === true`);
        await a.page.waitForTimeout(500);
        await neverDone(run, a.page, [A]);
        await until(a.page, `${state(A)}?.state === "running"`);
        await trackerControl(run, a.page, A).waitFor();

        // B streams in the new chat; nothing of A reaches it.
        await send(run, a.page, pb);
        await until(a.page, `p.activeSessionId() !== null && p.activeSessionId() !== ${JSON.stringify(A)}`);
        const B = (await probe(a.page, (p) => p.activeSessionId()))!;
        await a.page.getByText("Setting out: Row through Scylla's strait").first().waitFor();
        const inB = (await probe(a.page, (p) => p.transcript(p.activeSessionId()))).join("\n");
        expect(inB, "B's transcript is B's").toContain("Scylla");
        expect(inB, "and holds nothing of A").not.toContain("Sirens");
        expect(await probe(a.page, (p) => p.views().map((v) => v.sessionId))).toEqual([A]);

        // Leaving B: two trackers, both running, drawn where the width puts them.
        await newChat(run, a.page);
        await until(a.page, "p.views().length === 2 && p.views().every((v) => v.state === 'running')");
        await trackerControl(run, a.page, B).waitFor();
        expect((await drawn(run, a.page)).sort(), "both drawn").toEqual([A, B].sort());
        await neverDone(run, a.page, [A, B]);

        // B fails unwatched: failed, and announced once.
        await release(pb, "fail");
        await until(a.page, `${state(B)}?.state === "failed"`);
        await until(a.page, "p.spoken().length >= 1");
        await a.page.waitForTimeout(300);
        expect(await probe(a.page, (p) => p.spoken()), "B's failure is spoken once").toEqual([`${titles.get(B)} failed.`]);

        // Two minutes pass: A's age is redrawn, and nothing is announced for it.
        await a.page.clock.fastForward("02:05");
        const age = trackerControl(run, a.page, A).first();
        await a.page.waitForFunction((el) => el?.textContent?.includes("running · 2m") ?? false, await age.elementHandle(), { timeout: 10_000 });
        expect(await age.getAttribute("aria-label")).toBe(`${titles.get(A)}, running, 2m. Open session.`);
        expect(await probe(a.page, (p) => p.spoken()), "a ticking age announces nothing").toEqual([`${titles.get(B)} failed.`]);

        // Opening A by its tracker: A's own text and image come back. A is
        // still running, so selecting it acknowledged nothing.
        await openTracker(run, a.page, A);
        await until(a.page, `p.activeSessionId() === ${JSON.stringify(A)}`);
        await until(a.page, `p.draft().text === ${JSON.stringify(draftA)} && p.draft().images === 1`);
        expect(await composer(a.page).inputValue(), "A's words are back").toBe(draftA);
        expect(await a.page.locator("[data-composer] img").count(), "and A's image").toBe(1);
        await a.page.waitForTimeout(300);
        expect(await probe(a.page, (p) => p.views().find((v) => v.sessionId === p.activeSessionId())?.cleared), "selecting A cleared nothing").toBe(false);

        // Sent while A still runs: a follow-up the host queues. Leaving A
        // through Sessions tracks its newest request, queued, over the older
        // running turn; B, opened there, shows its failure and is seen.
        // A is still running, so its composer offers Stop, not Send, at
        // every width: the follow-up goes with the keyboard's Enter. (The
        // phone run pressed Send while a history replay wrongly ended A's
        // stream; #1013 keeps it running.)
        await composer(a.page).press("Enter");
        await a.page.locator('[data-row-half="right"] [data-pill]').first().waitFor();
        await openFromSessions(run, a.page, B);
        await until(a.page, `${state(A)}?.state === "queued"`);
        await neverDone(run, a.page, [A]);
        await until(a.page, `${state(B)}?.cleared === true`);

        // A's first turn ends and the follow-up runs: running again, not done.
        await release(pa);
        await until(a.page, `${state(A)}?.state === "running"`);
        await neverDone(run, a.page, [A]);

        // Watching A behind a panel: it finishes, and is not seen until the
        // panel goes and its latest turn is on screen.
        await openTracker(run, a.page, A);
        await until(a.page, `p.activeSessionId() === ${JSON.stringify(A)}`);
        await press(run, a.page.getByRole("tab", { name: /^Files/ }).locator("visible=true").first());
        await release(draftA);
        await until(a.page, `${state(A)}?.state === "done"`);
        await a.page.waitForTimeout(400);
        expect(await probe(a.page, (p) => p.views().find((v) => v.sessionId === p.activeSessionId())?.cleared), "a panel over Chat is not seen").toBe(false);
        await press(run, a.page.getByRole("tab", { name: /^Chat/ }).locator("visible=true").first());
        const disc = button(a.page, "Scroll to latest");
        if (!(await until(a.page, `${state(A)}?.cleared === true`, 3000).then(() => true, () => false))) await press(run, disc);
        await until(a.page, `${state(A)}?.cleared === true`);
        expect(await probe(a.page, (p) => p.records())).toMatchObject({ [A]: { seen: { basis: "proof" } } });

        // C, left running and opened again, finishes while the reader has
        // scrolled up: not seen until the latest turn is brought into view.
        await newChat(run, a.page);
        await send(run, a.page, pc);
        await until(a.page, `p.activeSessionId() !== null && ![${JSON.stringify(A)}, ${JSON.stringify(B)}].includes(p.activeSessionId())`);
        const C = (await probe(a.page, (p) => p.activeSessionId()))!;
        await newChat(run, a.page);
        await until(a.page, `${state(C)}?.state === "running"`);
        await openTracker(run, a.page, C);
        await until(a.page, `p.activeSessionId() === ${JSON.stringify(C)}`);
        await a.page.getByText("Day 40: the wax held, and the crew rowed on.").first().waitFor({ state: "attached" });
        await scrollUp(run, a.page);
        await disc.waitFor();
        await release(pc);
        await until(a.page, `${state(C)}?.state === "done"`);
        await a.page.getByText("Landed: Row on to Thrinacia").first().waitFor({ state: "attached" });
        await a.page.waitForTimeout(400);
        expect(await probe(a.page, (p) => p.views().find((v) => v.sessionId === p.activeSessionId())?.cleared), "scrolled up is not seen").toBe(false);
        await press(run, disc);
        await until(a.page, `${state(C)}?.cleared === true`);

        // Each change was spoken exactly once, in order: B's failure, A
        // finishing behind the panel, C finishing while scrolled up. Nothing
        // else (no age tick, no replay, no reopening) was spoken. Nothing was
        // aborted or confirmed, and each prompt ran exactly once.
        expect(await probe(a.page, (p) => p.spoken()), "every change spoken once, and nothing else").toEqual([
          `${titles.get(B)} failed.`, `${titles.get(A)} is done.`, `${titles.get(C)} is done.`,
        ]);
        expect(aborted.filter((p) => [pa, pb, draftA, pc].includes(p)), "nothing aborted").toEqual([]);
        expect(a.dialogs, "no native dialog").toEqual([]);
        expect(await confirmations(a.page), "no confirmation").toBe(0);
        for (const p of [pa, pb, draftA, pc]) expect(started.filter((s) => s.prompt === p), `${p} ran once`).toHaveLength(1);
      } finally {
        await a.context.close();
        for (const p of [pa, pb, draftA, pc]) gates.get(p)?.("ok");
        await clearHostDrafts();
      }
    }, 180_000);

    for (const touch of run.options.hasTouch
      ? [undefined, { holdMs: 0, motion: "reduce" as const }, { holdMs: 150, motion: "reduce" as const }, { holdMs: 0, motion: "no-preference" as const }]
      : [undefined]) {
      const approvalRun: Run = touch ? { ...run, options: { ...run.options, reducedMotion: touch.motion } } : run;
      const activation = touch ? ` [native touch, ${touch.holdMs}ms, motion=${touch.motion}]` : "";
      test(`${run.name}${activation}: an approval, all four question forms and running work fold into a summary; a reconnect, a reload and a host restart keep them, and none reads done`, async () => {
        const tag = `(${run.name}${activation})`;
        const a = await device(approvalRun);
        const approve = `Approve: Seal the crew's ears ${tag}`;
        const asks = (Object.keys(ASKS) as AskKind[]).map((kind) => `${kind}: Plan the raft, ${kind.toLowerCase()} ${tag}`);
        const hold = `Hold: Keep watch on the cliffs ${tag}`;
        const ids: Record<string, string> = {};
        try {
          // Six sessions, each left by New chat while it waits on the reader
          // or still runs.
          for (const prompt of [approve, ...asks, hold]) {
            await send(run, a.page, prompt);
            await until(a.page, `p.activeSessionId() !== null && !${JSON.stringify(Object.values(ids))}.includes(p.activeSessionId())`);
            ids[prompt] = (await probe(a.page, (p) => p.activeSessionId()))!;
            if (prompt === approve) await a.page.locator("[data-approval-card]").waitFor();
            else if (prompt !== hold) await a.page.locator("[data-ask-waiting]").first().waitFor();
            else await a.page.getByText("Setting out: Keep watch on the cliffs").first().waitFor();
            await newChat(run, a.page);
          }
          const all = Object.values(ids);
          const expected = (v: View) => v.sessionId === ids[approve] ? v.state === "needs_you" && v.pendingKind === "approval"
            : v.sessionId === ids[hold] ? v.state === "running"
            : v.state === "needs_you" && v.pendingKind === "question";
          const states = async () => probe(a.page, (p) => p.views());
          await until(a.page, `p.views().length === 6 && p.views().every((v) => v.state === "needs_you" || v.state === "running")`);
          for (const v of await states()) expect(expected(v), `${v.sessionId}: ${v.state} ${v.pendingKind}`).toBe(true);
          // Needs you sorts first; running last.
          expect((await states()).at(-1)!.sessionId, "running sorts after needs you").toBe(ids[hold]);
          await neverDone(run, a.page, all);

          // Overflow: below 1280 the most urgent pill and a summary of the rest,
          // whose sheet lists all six; from 1280 the pane's Working lists all six.
          if (wide(run)) {
            await until(a.page, `document.querySelectorAll("section[data-sessions-pane] [data-working-row]").length === 6`);
            expect((await drawn(run, a.page)).sort()).toEqual([...all].sort());
          } else {
            const summary = a.page.locator('[data-row-half="left"] [data-strip-summary="overflow"]');
            await summary.waitFor();
            expect(await drawn(run, a.page), "one pill beside the summary").toHaveLength(1);
            expect(await summary.getAttribute("aria-label")).toMatch(/^5 more working sessions: .*\. Open list\.$/);
            const box = (await summary.boundingBox())!;
            expect(box.height, "the summary is a 44px target").toBeGreaterThanOrEqual(43.5);
            await press(run, summary);
            const sheet = a.page.locator("[data-working-sheet]");
            await sheet.waitFor();
            expect((await sheet.locator("[data-session]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.session!))).sort(), "the sheet lists all six").toEqual([...all].sort());
            await a.page.keyboard.press("Escape");
            await sheet.waitFor({ state: "detached" });
          }

          // A dropped connection: the same six, still unfinished.
          const opened = a.sockets.length;
          await dropConnections();
          // The page notices and opens a new socket to the host.
          const end = Date.now() + 30_000;
          while (a.sockets.length === opened && Date.now() < end) await Bun.sleep(100);
          expect(a.sockets.length, "a new socket after the drop").toBeGreaterThan(opened);
          await until(a.page, "p.connected()", 30_000);
          await until(a.page, "p.views().length === 6 && p.views().every((v) => v.settled)");
          for (const v of await states()) expect(expected(v), `after reconnect, ${v.sessionId}: ${v.state} ${v.pendingKind}`).toBe(true);
          await neverDone(run, a.page, all);

          // A reload whose recovery reads fail: the running session can't be
          // checked, a question the host hands over again still needs you, and
          // none reads done.
          await a.context.route("**/api/sessions/*/recovery", (route) => route.abort());
          await a.page.reload();
          await until(a.page, "p?.connected()");
          // The host hands the questions over again, but the running session
          // comes back only from this root's own stored set.
          await until(a.page, "p.views().length >= 5 && p.views().every((v) => v.settled)");
          await a.page.waitForTimeout(500);
          expect((await states()).map((v) => v.sessionId).sort(), "the stored set brings every tracker back").toEqual([...all].sort());
          await until(a.page, `p.views().find((v) => v.sessionId === ${JSON.stringify(ids[hold])})?.state === "cant_check"`);
          for (const v of await states()) expect(["needs_you", "cant_check"], `unreadable, ${v.sessionId}`).toContain(v.state);
          await neverDone(run, a.page, all);
          // The reads come back: the host's own answer, restored, and a cold
          // load announces nothing.
          await a.context.unroute("**/api/sessions/*/recovery");
          await a.page.reload();
          await until(a.page, "p?.connected()");
          await until(a.page, "p.views().length === 6 && p.views().every((v) => v.settled && v.state !== 'cant_check')");
          for (const v of await states()) expect(expected(v), `after reload, ${v.sessionId}: ${v.state} ${v.pendingKind}`).toBe(true);
          await a.page.waitForTimeout(500);
          expect(await probe(a.page, (p) => p.spoken()), "a reload announces nothing").toEqual([]);

          // The approval, opened from its tracker after the reload: its card is
          // restored, answering it finishes the turn, and seeing that clears it.
          await openTracker(run, a.page, ids[approve]!);
          await until(a.page, `p.activeSessionId() === ${JSON.stringify(ids[approve])}`);
          const card = a.page.locator("[data-approval-card]");
          await card.waitFor();
          expect(answers.has(approve), "nothing answered by opening").toBe(false);
          const original = a.approvals.map((entry) => entry.frame).find((frame) => frame.type === "tool_approval_request" && frame.sessionId === ids[approve]);
          expect(original?.type, "the original approval request was observed").toBe("tool_approval_request");
          if (original?.type !== "tool_approval_request") throw new Error("Missing original approval request");
          expect(original.turnId, "the host bound the approval to a turn").toBeTruthy();
          const replies = () => a.approvals.filter(({ event, frame }) => event === "framesent" && frame.type === "tool_approval" && frame.toolUseId === original.toolUseId);
          expect(replies(), "opening and restoring never sends an approval").toHaveLength(0);
          try {
            const allow = card.getByRole("button", { name: "Allow", exact: true });
            if (touch) {
              // A reader can touch a visible card before its entrance settles.
              // No stable-element wait, second tap or synthetic DOM click (#1217).
              await allow.scrollIntoViewIfNeeded();
              const box = (await allow.boundingBox())!;
              const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
              expect(await a.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent, point),
                "the native gesture targets the visible Allow control").toContain("Allow");
              const cdp = await a.context.newCDPSession(a.page);
              try {
                await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
                if (touch.holdMs) await Bun.sleep(touch.holdMs);
                await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              } finally {
                await cdp.detach();
              }
            } else await press(run, allow);
            // `cleared` means seen (D52 §4), and may already be true while the
            // card still waits. It cannot prove delivery or completion (#1217).
            const replyDeadline = Date.now() + 5_000;
            while (replies().length === 0 && Date.now() < replyDeadline) await Bun.sleep(10);
            expect(replies(), "Allow emits exactly one reply for the original approval").toHaveLength(1);
            if (touch) {
              const inputs = await a.page.evaluate(() => (window as unknown as { __approvalTouches: ApprovalInput[] }).__approvalTouches);
              const down = inputs.find((event) => event.type === "pointerdown" && event.target?.trim() === "Allow");
              const up = inputs.find((event) => event.type === "pointerup" && event.target?.trim() === "Allow");
              expect(down, "the native touch reached Allow").toBeDefined();
              expect(up, "the native touch ended on Allow").toBeDefined();
              expect(up!.node, "the same control survives the gesture").toBe(down!.node);
              expect(up!.connected, "the control stays mounted until the gesture ends").toBe(true);
              expect(Math.abs(up!.y! - down!.y!), "the approval target stays still through the gesture").toBeLessThan(0.5);
              expect(inputs.filter((event) => event.type === "click" && event.target?.trim() === "Allow"),
                "the gesture generated exactly one click").toHaveLength(1);
            }
            expect(replies()[0]!.frame).toMatchObject({ type: "tool_approval", toolUseId: original.toolUseId, turnId: original.turnId, channel: "card" });
            const decisionDeadline = Date.now() + 5_000;
            while (!answers.has(approve) && Date.now() < decisionDeadline) await Bun.sleep(10);
            expect(answers.get(approve), "the backend settled the original approval").toBe("allow");
            await a.page.getByText("Sealed: Seal the crew's ears.", { exact: true }).first().waitFor({ state: "attached" });
            await until(a.page, `p.views().some((v) => v.sessionId === ${JSON.stringify(ids[approve])} && v.turnId === ${JSON.stringify(original.turnId)} && v.state === "done" && v.cleared)`);
            expect(a.approvals.filter(({ event, frame }) => event === "framereceived" && frame.type === "tool_result" && frame.toolUseId === original.toolUseId).map(({ frame }) => frame)).toEqual([
              expect.objectContaining({ type: "tool_result", sessionId: ids[approve], turnId: original.turnId, isError: false, output: "Ears sealed." }),
            ]);
            const response = await fetch(`${origin}/api/sessions/${ids[approve]}/recovery`);
            expect(response.status, "the host supplied completion evidence").toBe(200);
            const recovery = await response.json() as SessionRecovery;
            expect(recovery).toMatchObject({ sessionId: ids[approve], latest: { turnId: original.turnId, state: "terminal", outcome: "success" }, pending: [] });
            expect(replies(), "completion introduced no duplicate decision").toHaveLength(1);
            for (const v of (await states()).filter((v) => v.sessionId !== ids[approve])) {
              expect(expected(v), `approval completion does not settle ${v.sessionId}`).toBe(true);
              expect(v.cleared, `approval completion does not clear ${v.sessionId}`).toBe(false);
            }
          } catch (error) {
            // Keep the failed assertion, plus evidence separating a missed
            // gesture, a missing/wrong reply and a host that did not settle.
            const [touches, views, records, recovery] = await Promise.allSettled([
              a.page.evaluate(() => (window as unknown as { __approvalTouches: unknown[] }).__approvalTouches),
              states(), probe(a.page, (p) => p.records()),
              fetch(`${origin}/api/sessions/${ids[approve]}/recovery`).then((response) => response.json()),
            ]);
            console.error("Restored approval diagnostic", JSON.stringify({
              run: `${run.name}${activation}`, runtime: Bun.version, browser: browser!.version(), original, frames: a.approvals, answer: answers.get(approve) ?? null,
              touches, views, records, recovery,
            }));
            throw error;
          }

          // A normal host restart ends the running turn and the waiting
          // questions with the process. The trackers stay, and none reads done.
          await restartHost();
          await until(a.page, "p.connected()", 30_000);
          await a.page.reload();
          await until(a.page, "p?.connected()");
          const left = all.filter((id) => id !== ids[approve]);
          // The host no longer holds any of this work, so only the root's own
          // stored set can bring these trackers back.
          await until(a.page, `${JSON.stringify(left)}.every((id) => p.views().some((v) => v.sessionId === id && v.settled && !v.cleared))`);
          expect((await states()).map((v) => v.sessionId).sort(), "the trackers survive a restart and a reload").toEqual(expect.arrayContaining([...left].sort()));
          await neverDone(run, a.page, left);
          for (const v of (await states()).filter((x) => left.includes(x.sessionId))) {
            expect(["failed", "cancelled", "unknown"], `after a restart, ${v.sessionId} is ${v.state}`).toContain(v.state);
          }
          expect(a.dialogs).toEqual([]);
        } finally {
          await a.context.close();
          // Questions still waiting would reach the next test's page.
          await restartHost();
          await clearHostDrafts();
        }
      }, 240_000);
    }

    test(`${run.name}: each session keeps its own draft through every entry point, a reload, a host restart and another device; refused saves keep the words`, async () => {
      const tag = `(${run.name})`;
      const a = await device(run);
      let b: Device | undefined;
      const plan = `Plan: Harbours of Ithaca ${tag}`;
      const draftA = `Ask which harbour is safest in winter ${tag}`;
      const letter = `Letter to Penelope ${tag}`;
      const late = `Late: Word to Telemachus ${tag}`;
      const other = `Tell Eumaeus to wait ${tag}`;
      const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) }).locator("visible=true").first();
      /** A's own text and image are in the composer, and nothing else is. */
      const holdsA = async (page: Page, where: string) => {
        await until(page, `p.draft().text === ${JSON.stringify(draftA)} && p.draft().images === 1`);
        expect(await composer(page).inputValue(), `A's words after ${where}`).toBe(draftA);
        expect(await page.locator("[data-composer] img").count(), `A's image after ${where}`).toBe(1);
      };
      /** Goes to a destination that unmounts the composer, and back to Chat. */
      const away = async (page: Page, to: "Actions" | "Graph") => {
        if (to === "Actions") await press(run, tab(page, "Actions"));
        else if (phone(run)) { await press(run, tab(page, "More")); await press(run, page.getByRole("dialog", { name: "More" }).getByRole("button", { name: /^Graph/ }).first()); }
        else { await press(run, page.getByRole("button", { name: /^All commands/ }).locator("visible=true").first()); await press(run, page.getByRole("option", { name: /^Graph/ })); }
        await until(page, `p.view() === ${JSON.stringify(to === "Actions" ? "activity" : "graph")}`);
        expect(await composer(page).count(), `${to} unmounts the composer`).toBe(0);
        await press(run, tab(page, "Chat"));
        await until(page, "p.view() === 'chat'");
      };
      try {
        await send(run, a.page, plan);
        await until(a.page, "p.activeSessionId() !== null");
        const A = (await probe(a.page, (p) => p.activeSessionId()))!;
        await a.page.getByText("Noted: Harbours of Ithaca").first().waitFor();
        await composer(a.page).fill(draftA);
        await a.page.locator('input[type="file"][accept="image/*"]:not([capture])').setInputFiles({ name: "sail.png", mimeType: "image/png", buffer: SAIL });
        await until(a.page, "p.draft().images === 1");
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        expect(await a.page.locator("[data-draft-save]").textContent()).toBe("draft · saved");
        await hostUntil((d) => d.some((x) => x.sessionId === A && x.preview === draftA && x.attachmentCount === 1));

        // New chat by the visible control: empty, and the letter is its own draft.
        await newChat(run, a.page);
        expect(await composer(a.page).inputValue()).toBe("");
        await composer(a.page).fill(letter);
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        // Back to A through the Sessions destination's own row.
        await openFromSessions(run, a.page, A);
        await holdsA(a.page, "the Sessions row");
        // Through destinations that unmount the composer, and back.
        await away(a.page, "Actions");
        await holdsA(a.page, "Actions and back");
        await away(a.page, "Graph");
        await holdsA(a.page, "Graph and back");

        // New chat by a second entry point: the palette row from 480 up,
        // the Sessions drawer's New conversation on a phone. Repeating it on
        // an empty chat adds nothing.
        const second = async () => {
          if (phone(run)) { await press(run, tab(a.page, "Sessions")); await press(run, button(a.page, "New conversation")); }
          else { await press(run, a.page.getByRole("button", { name: /^All commands/ }).locator("visible=true").first()); await press(run, a.page.getByRole("option", { name: /^New chat/ })); }
          await until(a.page, "p.activeSessionId() === null && p.view() === 'chat'");
        };
        await second();
        expect(await composer(a.page).inputValue(), "the second New chat is empty too").toBe("");
        await second();
        expect(await probe(a.page, (p) => p.unbound()), "repeated empty New chats add nothing").toEqual([letter]);

        // The letter is a Draft entry in Sessions; opening it sends nothing.
        const before = started.length;
        if (!wide(run)) await press(run, tab(a.page, "Sessions"));
        const entry = a.page.locator("[data-drafts-group] [data-draft-row] [role='button']").locator("visible=true").first();
        expect(await entry.getAttribute("aria-label")).toBe(`Draft: ${letter}, saved. Open draft.`);
        await press(run, entry);
        await until(a.page, `p.draft().text === ${JSON.stringify(letter)} && p.activeSessionId() === null`);
        expect(await composer(a.page).inputValue()).toBe(letter);
        expect(started.length, "opening a draft starts nothing").toBe(before);

        // A reload, then a normal host restart and another reload: the host
        // brings back A's text and image and the letter's entry.
        await a.page.reload();
        await until(a.page, "p?.connected() && p.draftsSupported() === true");
        await until(a.page, `p.unbound().length === 1`);
        await openFromSessions(run, a.page, A);
        await holdsA(a.page, "a reload");
        await restartHost();
        await a.page.reload();
        await until(a.page, "p?.connected() && p.draftsSupported() === true");
        await openFromSessions(run, a.page, A);
        await holdsA(a.page, "a host restart");
        expect(await probe(a.page, (p) => p.unbound())).toEqual([letter]);

        // Another device of the same operator: the same draft and entry.
        b = await device(run);
        await until(b.page, `p.unbound().length === 1`);
        await openFromSessions(run, b.page, A);
        await holdsA(b.page, "opening it on another device");
        await b.context.close();
        b = undefined;

        // Offline: kept, and never called saved, until the host answers again.
        await a.context.route("**/api/drafts/**", (route) => route.abort());
        const offline = `${draftA}, and the wind`;
        await composer(a.page).fill(offline);
        await a.page.locator('[data-draft-save="unsaved"]').waitFor({ timeout: 20_000 });
        expect(await a.page.locator("[data-draft-save]").textContent()).toBe("draft · not saved yet");
        expect((await hostDrafts()).find((x) => x.sessionId === A)?.preview, "the host still has the last saved words").toBe(draftA);
        await a.context.unroute("**/api/drafts/**");
        await a.page.locator('[data-draft-save="saved"]').waitFor({ timeout: 20_000 });
        // Too large for the host: kept here, and the host's copy untouched.
        const huge = `${draftA} ${"wine-dark sea ".repeat(5_000)}`;
        await composer(a.page).fill(huge);
        await a.page.locator('[data-draft-save="too_large"]').waitFor({ timeout: 20_000 });
        expect(await a.page.locator("[data-draft-save]").textContent()).toBe("draft · too large to save (64 KB max) · kept on this device");
        expect(await composer(a.page).inputValue(), "the words stay").toBe(huge);
        expect((await hostDrafts()).find((x) => x.sessionId === A)?.preview).toBe(offline);
        await composer(a.page).fill(draftA);
        await a.page.locator('[data-draft-save="saved"]').waitFor({ timeout: 20_000 });

        // A first message still unanswered when the reader leaves its new
        // chat: its session, once named, is not selected, and the new chat's
        // words stay its own.
        await newChat(run, a.page);
        await send(run, a.page, late);
        for (let i = 0; i < 200 && !gates.has(late); i++) await Bun.sleep(25);
        expect(gates.has(late), "the host holds the first message unnamed").toBe(true);
        // Still unanswered: leave it by New chat.
        await newChat(run, a.page);
        expect(await composer(a.page).inputValue()).toBe("");
        await composer(a.page).fill(other);
        await a.page.locator('[data-draft-save="saved"]').waitFor();
        await release(late);
        await until(a.page, `p.views().some((v) => !${JSON.stringify([A])}.includes(v.sessionId))`);
        expect(await probe(a.page, (p) => p.activeSessionId()), "the late session is not selected").toBeNull();
        expect(await composer(a.page).inputValue(), "the new chat keeps its own words").toBe(other);
        const L = started.find((s) => s.prompt === late)!.sessionId;
        expect(await probe(a.page, (p) => p.transcript(null).join("\n")), "the late answer is not in the new chat").not.toContain("Telemachus");
        await openTracker(run, a.page, L);
        await until(a.page, `p.activeSessionId() === ${JSON.stringify(L)}`);
        await a.page.getByText("Noted: Word to Telemachus").first().waitFor();
        expect(await composer(a.page).inputValue(), "the late session's draft was its sent message, consumed").toBe("");
        expect(await probe(a.page, (p) => p.unbound()).then((u) => u.sort())).toEqual([letter, other].sort());
        expect(started.filter((s) => s.prompt === late), "sent once").toHaveLength(1);

        // Full: the host keeps 100 drafts; the 101st is kept here and says so.
        const filler: string[] = [];
        const live = (await hostDrafts()).length;
        for (let i = live; i < 100; i++) {
          const id = `odysseus-filler-${i}-${run.options.viewport!.width}`;
          filler.push(id);
          const res = await fetch(`${origin}/api/drafts/${id}`, { method: "PUT", headers: { origin, "content-type": "application/json", "if-match": "0", "idempotency-key": `${id}-k` }, body: JSON.stringify({ sessionId: null, text: `Supply list ${i}`, attachmentIds: [] }) });
          if (!res.ok) throw new Error(`filler ${i}: ${res.status} ${await res.text()}`);
        }
        await newChat(run, a.page);
        const overflow = `One more list for the raft ${tag}`;
        await composer(a.page).fill(overflow);
        await a.page.locator('[data-draft-save="full"]').waitFor({ timeout: 20_000 });
        expect(await a.page.locator("[data-draft-save]").textContent()).toMatch(/100 drafts saved/);
        expect(await composer(a.page).inputValue()).toBe(overflow);
        expect((await hostDrafts()).some((x) => x.preview === overflow), "never claimed saved").toBe(false);
        expect(a.dialogs).toEqual([]);
        expect(aborted.filter((p) => p === plan || p === late), "nothing this test sent was aborted").toEqual([]);
      } finally {
        await b?.context.close();
        await a.context.close();
        gates.get(late)?.("ok");
        await clearHostDrafts();
      }
    }, 240_000);

    test(`${run.name}: a new chat holding only a staged track stays reachable through New chat and sends nothing; removing its track ends the entry (#1112)`, async () => {
      const tag = `(${run.name})`;
      const a = await device(run);
      const plan = `Plan: Route to Pylos ${tag}`;
      const name = "ithaca-to-pylos-coastal-route-day-3.geojson";
      const route = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Ithaca to Pylos" }, geometry: { type: "LineString", coordinates: [[20.71, 38.37], [20.95, 38.1], [21.3, 37.6], [21.69, 37.03]] } }] }));
      const tab = (page: Page, label: string) => page.getByRole("tab", { name: new RegExp(`^${label}`) }).locator("visible=true").first();
      const remove = () => a.page.getByRole("button", { name: `Remove ${name}`, exact: true });
      const entry = () => a.page.locator("[data-drafts-group] [data-draft-row] [role='button']").locator("visible=true");
      /** The staged track is in this composer, read by the real host. */
      const chipReady = async () => {
        await remove().waitFor();
        await a.page.waitForFunction((n) => /km/.test(document.querySelector(`[data-track-chip][aria-label^="${n}"]`)?.getAttribute("aria-label") ?? ""), name);
      };
      const openEntry = async () => {
        if (!wide(run)) await press(run, tab(a.page, "Sessions"));
        expect(await entry().count(), "one Draft entry").toBe(1);
        expect(await entry().first().getAttribute("aria-label")).toBe("Draft: Draft with 1 track file, tracks in this tab only. Open draft.");
        await press(run, entry().first());
        await until(a.page, "p.activeSessionId() === null && p.view() === 'chat'");
        await chipReady();
        expect(await composer(a.page).inputValue(), "no words appeared").toBe("");
      };
      try {
        await send(run, a.page, plan);
        await until(a.page, "p.activeSessionId() !== null");
        await a.page.getByText("Noted: Route to Pylos").first().waitFor();
        await newChat(run, a.page);
        await a.page.locator('input[type="file"][accept*=".gpx"]').setInputFiles({ name, mimeType: "application/geo+json", buffer: route });
        await chipReady();
        const before = started.length;

        // New chat by the palette from 480 up, and by Sessions' New conversation at every width.
        if (!phone(run)) {
          await press(run, a.page.getByRole("button", { name: /^All commands/ }).locator("visible=true").first());
          await press(run, a.page.getByRole("option", { name: /^New chat/ }));
          await until(a.page, "p.activeSessionId() === null");
          expect(await remove().count(), "the new chat opens without the track").toBe(0);
          await openEntry();
        }
        if (!wide(run)) await press(run, tab(a.page, "Sessions"));
        await press(run, button(a.page, "New conversation"));
        await until(a.page, "p.activeSessionId() === null");
        expect(await remove().count(), "the new chat opens without the track").toBe(0);
        await openEntry();
        expect(started.length, "nothing was sent").toBe(before);

        // The last track removed: out of Drafts, the field focused, nothing asked.
        await press(run, remove());
        await remove().waitFor({ state: "detached" });
        expect(await a.page.evaluate(() => document.activeElement?.matches("textarea[data-composer]") ?? false), "focus is in the field").toBe(true);
        if (!wide(run)) await press(run, tab(a.page, "Sessions"));
        expect(await a.page.locator("[data-drafts-group]").count(), "no Draft entry is left").toBe(0);
        expect(await confirmations(a.page)).toBe(0);
        expect(a.dialogs).toEqual([]);
        expect(started.length, "nothing was sent").toBe(before);
      } finally {
        await a.context.close();
        await clearHostDrafts();
      }
    }, 120_000);
  }
});

// Staged tracks live in this tab only (#1150): while any view holds one, a
// manual reload asks Chromium's own leave confirmation; once the last is sent
// or removed it does not, and a waiting update reloads once without asking.
// Chromium draws its own words, so the test reads the dialog's type. Under
// Playwright's control Chromium 152 asks even before any gesture; a user's
// browser also needs one (sticky activation), which this harness cannot show,
// so every cell presses something first, as a user would have.
const leaveRuns: Run[] = [
  { name: "320 phone, dark, coarse pointer, reduced motion", theme: "dark", options: { viewport: { width: 320, height: 720 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" } },
  { name: "1280 desktop, light, fine pointer", theme: "light", options: { viewport: { width: 1280, height: 800 } } },
];

describe.skipIf(!executablePath)("a staged track guards the tab it lives in", () => {
  const name = "ithaca-to-pylos-coastal-route-day-3.geojson";
  const route = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Ithaca to Pylos" }, geometry: { type: "LineString", coordinates: [[20.71, 38.37], [20.95, 38.1], [21.3, 37.6], [21.69, 37.03]] } }] }));
  const remove = (page: Page) => page.getByRole("button", { name: `Remove ${name}`, exact: true });
  const loads = (page: Page) => page.evaluate(() => (window as unknown as { __loads: number }).__loads);

  /** A browser reload: whether Chromium asked first, and whether a new document loaded. */
  async function reload(a: Device): Promise<{ asked: boolean; reloaded: boolean }> {
    const before = await loads(a.page);
    const asked = a.dialogs.length;
    // A refused confirmation leaves the reload waiting forever: bounded.
    const done = a.page.reload({ timeout: 4_000 }).then(() => true, () => false);
    const prompt = a.page.waitForEvent("dialog", { timeout: 4_000 }).then(() => true, () => false);
    // Asked: wait out the bound, so a navigation the refusal failed to stop is seen.
    if (await Promise.race([done.then(() => false), prompt])) await done;
    else if (await done) await until(a.page, "p?.connected()");
    return { asked: a.dialogs.slice(asked).includes("beforeunload"), reloaded: (await loads(a.page)) === before + 1 };
  }

  /** Session A, then a staged track in A's composer, then a new chat in view. Returns A. */
  async function stageInA(run: Run, a: Device, tag: string): Promise<string> {
    await send(run, a.page, `Plan: Route to Pylos ${tag}`);
    await until(a.page, "p.activeSessionId() !== null");
    await a.page.getByText("Noted: Route to Pylos").first().waitFor();
    const id = (await probe(a.page, (p) => p.activeSessionId()))!;
    await a.page.locator('input[type="file"][accept*=".gpx"]').setInputFiles({ name, mimeType: "application/geo+json", buffer: route });
    await remove(a.page).waitFor();
    await a.page.waitForFunction((n) => /km/.test(document.querySelector(`[data-track-chip][aria-label^="${n}"]`)?.getAttribute("aria-label") ?? ""), name);
    await newChat(run, a.page);
    expect(await remove(a.page).count(), "A is not in view").toBe(0);
    expect(await probe(a.page, (p) => p.staged()), "A holds the track").toBe(true);
    return id;
  }

  /** Back in A, its last track ends: removed by its chip, or sent with a message the host accepts. */
  async function end(run: Run, a: Device, id: string, ending: "removed" | "sent", tag: string) {
    await openFromSessions(run, a.page, id);
    await remove(a.page).waitFor();
    if (ending === "removed") {
      await press(run, remove(a.page));
    } else {
      const before = started.length;
      await send(run, a.page, `Note: Which harbour on this route? ${tag}`);
      for (let i = 0; i < 400 && started.length === before; i++) await Bun.sleep(25);
      expect(started.at(-1)?.sessionId, "the message went to A").toBe(id);
      expect(started.at(-1)?.prompt, "the track went with it").toStartWith(`Note: Which harbour on this route? ${tag}\n\n<brain-track-files>`);
    }
  }

  for (const run of leaveRuns) for (const ending of ["removed", "sent"] as const) {
    test(`${run.name}: a reload asks while A holds a staged track out of view, and not once it is ${ending}`, async () => {
      const tag = `(${run.name}, leave, ${ending})`;
      const a = await device(run, { update: true });
      try {
        // Nothing staged: nothing asked.
        await press(run, composer(a.page));
        expect(await reload(a), "no staged track: the reload proceeds").toEqual({ asked: false, reloaded: true });

        const id = await stageInA(run, a, tag);
        expect(await reload(a), "Chromium asks, and the refusal keeps the page").toEqual({ asked: true, reloaded: false });
        expect(await probe(a.page, (p) => p.staged()), "A's track is still staged").toBe(true);

        await end(run, a, id, ending, tag);
        await until(a.page, "!p.staged()");
        expect(await reload(a), `the track ${ending}: the reload proceeds without asking`).toEqual({ asked: false, reloaded: true });
        expect(a.dialogs, "one confirmation, for the staged track").toEqual(["beforeunload"]);
        expect(await confirmations(a.page)).toBe(0);
      } finally {
        await a.context.close();
        await clearHostDrafts();
      }
    }, 120_000);

    test(`${run.name}: a waiting update holds while A holds a staged track, then reloads once without asking when it is ${ending}`, async () => {
      const tag = `(${run.name}, update, ${ending})`;
      const a = await device(run, { update: true });
      try {
        const id = await stageInA(run, a, tag);
        const before = await loads(a.page);
        await a.page.evaluate(() => (window as unknown as { __worker: { takeover(): void } }).__worker.takeover());
        await a.page.waitForTimeout(500);
        expect(await loads(a.page), "the update waits for the staged track").toBe(before);

        await end(run, a, id, ending, tag);
        // The takeover's own reload: a script navigation, which a stale guard would ask about and stop.
        const loaded = () => loads(a.page).then((n) => n === before + 1, () => false);
        for (let i = 0; i < 600 && a.dialogs.length === 0 && !(await loaded()); i++) await Bun.sleep(25);
        expect(a.dialogs, "the takeover's reload asks nothing").toEqual([]);
        expect(await loaded(), "the update reloads once the track is gone").toBe(true);
        await until(a.page, "p?.connected()");
        await a.page.waitForTimeout(1_000);
        expect(await loads(a.page), "exactly one reload").toBe(before + 1);
        expect(a.dialogs, "nothing asked").toEqual([]);
      } finally {
        await a.context.close();
        await clearHostDrafts();
      }
    }, 120_000);
  }
});
