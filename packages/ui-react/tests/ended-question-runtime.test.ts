import { runtimePackageBuild } from "./fixtures/runtime-package-build";
/**
 * A question left unanswered until the host's turn limit ran out (#3356), in
 * real Chrome, on the public ChatPage, against the real host (`createApp`,
 * its WebSocket, SQLite catalog, coordinator, bridge and dispatch) with a
 * scripted backend that asks each of the four ask kinds and never gets an
 * answer in time.
 *
 * The host's configured hard limit is short here, as the issue's
 * verification asks; it is the same elapsed-time timer production arms.
 * What is proved: the turn ends at that limit and says so; the card keeps the
 * draft the user typed but did not submit; nothing is sent to the ended
 * request, before or after the card's Submit; only the explicit Send as
 * message, operated from the keyboard, starts one new, ordinary, admitted
 * message carrying the question and that answer; and a replay of the
 * runtime's stop notice shows a status without a fresh alert. Nothing leaves
 * 127.0.0.1.
 */
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import type { AgentBackend, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Ended question runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING ended question runtime proof: no Chrome; ended-card recovery is unverified locally.");

type Kind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
const KINDS: Kind[] = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"];
const TOOL: Record<Kind, string> = {
  ask_user: "mcp__brain-ui__ask_user",
  ask_user_list: "mcp__brain-ui__ask_user_list",
  ask_user_rank: "mcp__brain-ui__ask_user_rank",
  ask_user_form: "mcp__brain-ui__ask_user_form",
};
const NOTE = "Bind the oars, Ὀδυσσεύς";
const INPUT: Record<Kind, Record<string, unknown>> = {
  ask_user: { questions: [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor’s court" }] }] },
  ask_user_list: { prompt: "Choose raft supplies", items: [{ id: "rope", label: "Rope" }], scale: [{ label: "Pack" }, { label: "Leave" }], allowSkip: false, notes: false },
  ask_user_rank: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] },
  ask_user_form: { prompt: "Record raft supplies", nodes: [{ id: "note", kind: "text", prompt: "Supply note", required: true }] },
};
/** What the new message must carry: the question and the user's own draft. */
const CARRIES: Record<Kind, string[]> = {
  ask_user: ["Which harbour first?", "Pylos"],
  ask_user_list: ["Choose raft supplies", "Rope", "Leave"],
  ask_user_rank: ["Order raft supplies", "1. Timber", "2. Rope"],
  ask_user_form: ["Record raft supplies", NOTE],
};

/** The host's configured hard limit for every turn in this suite. */
const TURN_TIMEOUT_MS = 4_000;

let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "";
let sequence = 0;
/** Every settlement the backend's ask tools received, by request id. */
const settlements = new Map<string, unknown[]>();
/** Every turn's first prompt line, in arrival order. */
const prompts: string[] = [];
/** When each asking turn started and when its signal aborted, by request id. */
const clocks = new Map<string, { startedAt: number; askedAt?: number; abortedAt?: number }>();
const histories = new Map<string, SessionHistoryMessage[]>();

const hook = runtimeHookPhases("ended-question-runtime");

beforeAll(async () => {
  if (!executablePath) return;
  const repo = resolve(import.meta.dir, "../../..");
  const [buildOut, buildErr, buildCode] = await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  if (buildCode !== 0) throw new Error(`Ended question fixture build failed (${buildCode}): ${buildOut}\n${buildErr}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-ended-question-"));
  const brain = resolve(scratch, "brain");
  await hook.phase("fixture-brain", () => createFixtureBrain(repo, brain));
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = await hook.phase("client-build", () => Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/answer-delivery-client.ts")],
    target: "browser",
    conditions: ["bun"],
    outdir: assets,
    naming: "client.js",
  }));
  if (!bundle.success) throw new Error(`Ended question client build failed: ${bundle.logs.join("\n")}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  const backend: AgentBackend = {
    id: "ended-scripted",
    capabilities: { resume: true, permissions: false, thinking: false, attachments: false, askUser: true, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "ended-scripted", label: "Local fixture" }],
    listSessions: async () => [],
    getHistory: async (sessionId) => histories.get(sessionId) ?? [],
    async startTurn({ prompt: contextPrompt, bridge, signal, sessionId: resumed }) {
      const prompt = contextPrompt.split("\n", 1)[0]!;
      prompts.push(contextPrompt);
      const kind = prompt.split(":", 1)[0] as Kind;
      if (!KINDS.includes(kind)) {
        // The recovery message: an ordinary new turn in the same session.
        const sessionId = resumed!;
        bridge.emit({ type: "session_info", sessionId, isNew: false });
        bridge.emit({ type: "text_delta", sessionId, text: "Noted." });
        bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
        return;
      }
      const input = INPUT[kind];
      const n = ++sequence;
      const sessionId = `odysseus-ended-${n}`;
      const requestId = `toolu_${kind}_${n}`;
      const clock: { startedAt: number; askedAt?: number; abortedAt?: number } = { startedAt: Date.now() };
      clocks.set(requestId, clock);
      signal.addEventListener("abort", () => { clock.abortedAt = Date.now(); }, { once: true });
      bridge.emit({ type: "session_info", sessionId, isNew: true });
      bridge.emit({ type: "text_delta", sessionId, text: "Before we sail: " });
      bridge.emit({ type: "tool_use_start", sessionId, toolUseId: requestId, toolName: TOOL[kind] });
      bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: requestId, toolName: TOOL[kind], input });
      const call = { id: requestId, name: TOOL[kind], input } as SessionHistoryMessage["toolCalls"][number];
      const settled: unknown[] = [];
      settlements.set(requestId, settled);
      clock.askedAt = Date.now();
      try {
        settled.push(kind === "ask_user"
          ? await bridge.askUser!(requestId, input.questions as never)
          : kind === "ask_user_list"
            ? await bridge.askUserList!(requestId, input as never)
            : kind === "ask_user_rank"
              ? await bridge.askUserRank!(requestId, input as never)
              : await bridge.askUserForm!(requestId, askUserFormSpec(input as never)));
      } catch (error) {
        const output = (error as Error).message;
        // What the runtime's transcript holds afterwards: the interrupted
        // call, and its own stop notice once the session is resumed.
        histories.set(sessionId, [
          { role: "user", content: prompt, toolCalls: [] },
          { role: "assistant", content: "Before we sail: ", toolCalls: [{ ...call, output, isError: true }],
            parts: [{ kind: "text", text: "Before we sail: " }, { kind: "tool", toolIndex: 0 }],
            runtimeNotice: { cause: "unspecified", message: "No response requested." } },
        ]);
        bridge.emit({ type: "tool_result", sessionId, toolUseId: requestId, output, isError: true });
        // The Claude turn runner's cancelled terminal: status, then result.
        bridge.emit({ type: "status", sessionId, status: "cancelled" });
        bridge.emit({ type: "result", sessionId, outcome: "cancelled", durationMs: 0, numTurns: 1, isError: false });
        return;
      }
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  app = await hook.phase("host-start", () => createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch!, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    staticRoot: assets,
    registry: createStaticBackendRegistry([backend], backend.id),
    observability: createRecordingObservability(),
    turnTimeoutMs: TURN_TIMEOUT_MS,
  }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 }));
  console.error("[ended-question-browser]", browser.version());
}, 180_000);

afterEach(() => {
  app?.cancelActiveTurns();
});

afterAll(() => hook.phase("cleanup", async () => {
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}));

interface Frames { up: Array<{ type: string; requestId?: string; text?: string }> }

async function newContext(width: number): Promise<{ context: BrowserContext; frames: Frames }> {
  const context = await browser!.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const frames: Frames = { up: [] };
  await context.routeWebSocket(/\/ws$/, (route) => {
    const upstream = route.connectToServer();
    route.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message));
        frames.up.push({ type: frame.type, requestId: frame.requestId, text: frame.text });
      } catch {}
      upstream.send(message);
    });
    upstream.onMessage((message) => route.send(message));
  });
  return { context, frames };
}

async function openPage(context: BrowserContext, theme: "dark" | "light"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__answers?.connected()");
  for (const css of ["../../ui-kit/dist/styles.css", "../dist/styles.css"]) {
    await page.addStyleTag({ content: await Bun.file(resolve(import.meta.dir, css)).text() });
  }
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  return page;
}

/** When the test pressed Send for the latest question's turn (same process clock as the host). */
let sentAt = 0;

async function ask(page: Page, kind: Kind): Promise<string> {
  const composer = page.locator("textarea.bk-composer");
  await composer.fill(kind);
  await page.waitForFunction(() => {
    const send = document.querySelector<HTMLElement>('[role="button"][aria-label="Send"]');
    return send !== null && send.getAttribute("aria-disabled") !== "true" && send.getClientRects().length > 0;
  });
  sentAt = Date.now();
  await composer.press("Enter");
  const request = await page.waitForFunction(() => {
    const ids = (window as unknown as { __answers: { activeCardRequestIds(): string[] } }).__answers.activeCardRequestIds();
    return ids.length === 1 ? ids[0] : false;
  });
  const requestId = await request.jsonValue() as string;
  await request.dispose();
  return requestId;
}

/** Leave a draft on the card, without submitting it. */
async function draft(page: Page, kind: Kind): Promise<void> {
  if (kind === "ask_user") await page.getByRole("radio", { name: /Pylos/ }).click();
  else if (kind === "ask_user_list") await page.getByRole("radio", { name: "Leave, Rope", exact: true }).click();
  else if (kind === "ask_user_rank") {
    await page.getByRole("button", { name: /^Timber, position 2 of 2/ }).click();
    await page.getByRole("button", { name: /^Rope, position 1 of 2/ }).click();
  } else await page.getByRole("textbox", { name: "Supply note", exact: true }).fill(NOTE);
}

/** The draft is still what the card shows. */
async function draftShown(page: Page, kind: Kind): Promise<boolean> {
  if (kind === "ask_user") return (await page.getByRole("radio", { name: /Pylos/ }).getAttribute("aria-checked")) === "true";
  if (kind === "ask_user_list") return (await page.getByRole("radio", { name: "Leave, Rope", exact: true }).getAttribute("aria-checked")) === "true";
  if (kind === "ask_user_rank") return (await page.getByRole("button", { name: "Submit order", exact: true }).count()) === 1;
  return (await page.getByRole("textbox", { name: "Supply note", exact: true }).inputValue()) === NOTE;
}

const ANSWER_FRAMES = new Set(["ask_user_response", "ask_user_list_response", "ask_user_rank_response", "ask_user_form_response", "ask_answer_status"]);

describe.skipIf(!executablePath)("a question whose turn timed out, in Chrome", () => {
  for (const kind of KINDS) {
    const width = kind === "ask_user_list" ? 320 : 390;
    const theme = kind === "ask_user_rank" ? "light" : "dark";
    test(`${kind}: the typed answer survives the timeout and leaves only by an explicit Send as message (${width}px, ${theme})`, async () => {
      const { context, frames } = await newContext(width);
      try {
        const page = await openPage(context, theme);
        if (kind === "ask_user_form") {
          // 200% text: the ended card and its footer still wrap without overflow.
          await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        }
        const requestId = await ask(page, kind);
        await draft(page, kind);

        // The host's limit ends the turn; the conversation says it timed out.
        await page.locator('[data-turn-notice="timeout"]').waitFor({ timeout: TURN_TIMEOUT_MS + 15_000 });
        const clock = clocks.get(requestId)!;
        // The host arms its limit when it admits the turn, before the backend
        // starts: never earlier than the limit after the user's send, and
        // less than the limit after the question arrived, so the question
        // neither restarted nor extended it.
        expect(clock.abortedAt! - sentAt, "TIMEOUT_NOT_EARLY").toBeGreaterThanOrEqual(TURN_TIMEOUT_MS);
        expect(clock.abortedAt! - clock.askedAt!, "TIMEOUT_NOT_RESTARTED_BY_QUESTION").toBeLessThan(TURN_TIMEOUT_MS);
        expect(await page.locator('[data-turn-notice="timeout"] [aria-live="polite"]').textContent(), "TIMEOUT_ANNOUNCED_ONCE_LIVE").toContain("Turn timed out");

        // The ended card still holds the draft, and says why it ended.
        const ended = page.locator("[data-ask-ended]");
        await ended.waitFor();
        expect(await ended.textContent()).toContain("The turn timed out before you answered");
        expect(await draftShown(page, kind), "ENDED_CARD_KEEPS_DRAFT").toBe(true);
        expect(frames.up.filter((f) => ANSWER_FRAMES.has(f.type)), "NOTHING_SENT_TO_ENDED_REQUEST").toEqual([]);

        // Submit on the ended card keeps the answer here, as Not delivered.
        const chatBefore = frames.up.filter((f) => f.type === "chat_message").length;
        const submit = kind === "ask_user_list" ? page.getByRole("button", { name: "Submit 1", exact: true })
          : kind === "ask_user_rank" ? page.getByRole("button", { name: "Submit order", exact: true })
            : page.getByRole("button", { name: "Submit", exact: true });
        await submit.click();
        const status = page.locator('[data-answer-delivery="closed"]');
        await status.waitFor();
        expect(await status.locator("h4").textContent()).toBe("NOT DELIVERED · QUESTION CLOSED");
        expect(await page.evaluate(() => document.activeElement?.tagName), "FOCUS_ON_OUTCOME").toBe("H4");
        expect(frames.up.filter((f) => ANSWER_FRAMES.has(f.type)), "SUBMIT_ON_ENDED_CARD_SENDS_NOTHING").toEqual([]);
        expect(frames.up.filter((f) => f.type === "chat_message").length, "NO_AUTOMATIC_CONTINUATION").toBe(chatBefore);

        // Send as message, from the keyboard: one ordinary new message.
        const sendAs = status.getByRole("button", { name: "Send as message", exact: true });
        expect(await sendAs.evaluate((el) => el.getBoundingClientRect().height), "SEND_AS_TOUCH_HEIGHT").toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "ENDED_CARD_NO_OVERFLOW").toBe(true);
        await sendAs.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.body.textContent?.includes("Noted."));
        const sent = frames.up.filter((f) => f.type === "chat_message").slice(chatBefore);
        expect(sent, "ONE_NEW_MESSAGE").toHaveLength(1);
        for (const part of CARRIES[kind]) expect(sent[0]!.text, "MESSAGE_CARRIES_QUESTION_AND_ANSWER").toContain(part);
        expect(prompts.at(-1)!.split("\n", 1)[0], "BACKEND_GOT_ORDINARY_MESSAGE").toBe(sent[0]!.text!.split("\n", 1)[0]);
        expect(await status.getByRole("button", { name: "Send as message" }).count(), "SEND_AS_MESSAGE_ONCE").toBe(0);
        expect(settlements.get(requestId), "OLD_REQUEST_NEVER_SETTLED").toEqual([]);
        expect(frames.up.filter((f) => ANSWER_FRAMES.has(f.type)), "OLD_REQUEST_NEVER_ANSWERED").toEqual([]);
      } finally { await context.close(); }
    }, TURN_TIMEOUT_MS + 60_000);
  }

  test("a reload replays the runtime's stop notice as a status, without a fresh alert or the agent's voice", async () => {
    const { context } = await newContext(390);
    try {
      const page = await openPage(context, "dark");
      await ask(page, "ask_user");
      await page.locator('[data-turn-notice="timeout"]').waitFor({ timeout: TURN_TIMEOUT_MS + 15_000 });
      await page.reload();
      await page.waitForFunction("window.__answers?.connected()");
      const notice = page.locator('[data-turn-notice="unspecified"]');
      await notice.waitFor();
      expect(await notice.textContent()).toContain("Turn ended without a reply");
      expect(await notice.locator('[aria-live="polite"]').textContent(), "REPLAY_DOES_NOT_ANNOUNCE").toBe("");
      expect(await page.locator("body").textContent(), "NOTICE_NOT_AGENT_PROSE").not.toContain("No response requested.");
      expect(await page.locator("body").textContent()).toContain("Before we sail:");
    } finally { await context.close(); }
  }, TURN_TIMEOUT_MS + 60_000);
});
