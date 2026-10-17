/**
 * Answer delivery (#910) in real Chrome, on the public ChatPage, against the
 * real host (`createApp`, its WebSocket, SQLite catalog and dispatch) with a
 * scripted backend that asks each of the four ask kinds.
 *
 * The page keeps its answers where production does: IndexedDB, coordinated
 * across tabs with Web Locks. The network between the page and the host is
 * Playwright's WebSocket route, which lets a test refuse connections, cut
 * one without closing it (a blackhole), drop a receipt in flight, or rewrite
 * the host's hello as an older or differently authenticated host would send
 * it. Nothing leaves 127.0.0.1.
 *
 * The phone PWA check reserved on #910 is not this: suspended timers and an
 * operating system's background policy are not reproduced here.
 */
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import type { AgentBackend, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
import { installPausedLivenessClock } from "./fixtures/liveness-clock";
import { installReceiptWatchdogObserver } from "./fixtures/receipt-watchdog-observer";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Answer delivery runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING answer delivery runtime proof: no Chrome; delivery recovery is unverified locally.");

type Kind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
const KINDS: Kind[] = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"];
const TOOL: Record<Kind, string> = {
  ask_user: "mcp__brain-ui__ask_user",
  ask_user_list: "mcp__brain-ui__ask_user_list",
  ask_user_rank: "mcp__brain-ui__ask_user_rank",
  ask_user_form: "mcp__brain-ui__ask_user_form",
};
const HARBOUR = "Ithaca — Ἰθάκη";
const NOTE = "Timber and rope, σχεδία for the raft";
const EXPECTED_RESULTS = {
  ask_user: { answers: { "Which harbour first?": HARBOUR } },
  ask_user_list: { answers: { rope: "Pack" } },
  ask_user_rank: { order: ["rope", "timber"], unchanged: true },
  ask_user_form: { answers: { note: NOTE } },
};
const INPUT: Record<Kind, Record<string, unknown>> = {
  ask_user: { questions: [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: HARBOUR, description: "Home" }, { label: "Pylos", description: "Nestor’s court" }] }] },
  ask_user_list: { prompt: "Choose raft supplies", items: [{ id: "rope", label: "Rope" }], scale: [{ label: "Pack" }, { label: "Leave" }], allowSkip: false, notes: false },
  ask_user_rank: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] },
  ask_user_form: { prompt: "Record raft supplies", nodes: [{ id: "note", kind: "text", prompt: "Supply note", required: true }] },
};

const ASK_VARIANTS: Record<string, Record<string, unknown>> = {
  "ask_user:multi": { questions: [{ ...(INPUT.ask_user.questions as Array<Record<string, unknown>>)[0], multiSelect: true }] },
  "ask_user:group": { questions: [
    ...(INPUT.ask_user.questions as unknown[]),
    { question: "Which supplies?", header: "Supplies", multiSelect: false, options: [{ label: "Rope", description: "For the raft" }] },
  ] },
};

let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "";
let sequence = 0;
/** Every settlement the backend's tools received, by request id. */
const settlements = new Map<string, unknown[]>();
const histories = new Map<string, SessionHistoryMessage[]>();

const hook = runtimeHookPhases("answer-delivery-runtime");

beforeAll(async () => {
  if (!executablePath) return;
  const repo = resolve(import.meta.dir, "../../..");
  // Unit shards start without dist. Generate the real package styles (and
  // their exported token dependency), as the sibling styled runtime fixtures
  // do, instead of depending on another test having built them first.
  const build = Bun.spawn([process.execPath, "scripts/build.ts", "--for", "ui-react,ui-server,core"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [buildOut, buildErr, buildCode] = await hook.child("package-build", build);
  if (buildCode !== 0) throw new Error(`Answer delivery fixture build failed (${buildCode}): ${buildOut}\n${buildErr}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-answer-delivery-"));
  const brain = resolve(scratch, "brain");
  await hook.phase("fixture-brain", () => createFixtureBrain(repo, brain));
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  // Bundled from source (the `bun` export condition), so what runs is this
  // checkout's code, not a stale dist.
  const bundle = await hook.phase("client-build", () => Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/answer-delivery-client.ts")],
    target: "browser",
    conditions: ["bun"],
    outdir: assets,
    naming: "client.js",
  }));
  if (!bundle.success) throw new Error(`Answer delivery client build failed: ${bundle.logs.join("\n")}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  const backend: AgentBackend = {
    id: "answers-scripted",
    capabilities: { resume: true, permissions: false, thinking: false, attachments: false, askUser: true, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "answers-scripted", label: "Local fixture" }],
    listSessions: async () => [],
    getHistory: async (sessionId) => histories.get(sessionId) ?? [],
    async startTurn({ prompt: contextPrompt, bridge }) {
      // Route the fixture command independently of appended host budget context.
      const prompt = contextPrompt.split("\n", 1)[0]!;
      const kind = prompt.split(":", 1)[0] as Kind;
      const input = ASK_VARIANTS[prompt] ?? INPUT[kind];
      const n = ++sequence;
      const sessionId = `odysseus-answers-${n}`;
      const requestId = `toolu_${kind}_${n}`;
      bridge.emit({ type: "session_info", sessionId, isNew: true });
      bridge.emit({ type: "tool_use_start", sessionId, toolUseId: requestId, toolName: TOOL[kind] });
      bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: requestId, toolName: TOOL[kind], input });
      const call = { id: requestId, name: TOOL[kind], input } as SessionHistoryMessage["toolCalls"][number];
      histories.set(sessionId, [
        { role: "user", content: prompt, toolCalls: [] },
        { role: "assistant", content: "", toolCalls: [call], parts: [{ kind: "tool", toolIndex: 0 }] },
      ]);
      const settled = settlements.get(requestId) ?? [];
      settlements.set(requestId, settled);
      let result: unknown;
      try {
        result =
          kind === "ask_user"
            ? await bridge.askUser!(requestId, input.questions as never)
            : kind === "ask_user_list"
              ? await bridge.askUserList!(requestId, INPUT.ask_user_list as never)
              : kind === "ask_user_rank"
                ? await bridge.askUserRank!(requestId, INPUT.ask_user_rank as never)
                : await bridge.askUserForm!(requestId, askUserFormSpec(INPUT.ask_user_form as never));
      } catch (error) {
        bridge.emit({ type: "tool_result", sessionId, toolUseId: requestId, output: (error as Error).message, isError: true });
        bridge.emit({ type: "result", sessionId, outcome: "cancelled", durationMs: 0, numTurns: 1, isError: false });
        return;
      }
      settled.push(result);
      const output = JSON.stringify(result);
      histories.set(sessionId, [
        { role: "user", content: prompt, toolCalls: [] },
        { role: "assistant", content: `Completed ${kind}`, toolCalls: [{ ...call, output }], parts: [{ kind: "tool", toolIndex: 0 }, { kind: "text", text: `Completed ${kind}` }] },
      ]);
      bridge.emit({ type: "tool_result", sessionId, toolUseId: requestId, output, isError: false });
      bridge.emit({ type: "text_delta", sessionId, text: `Completed ${kind}` });
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  app = await hook.phase("host-start", () => createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch!, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    staticRoot: assets,
    registry: createStaticBackendRegistry([backend], backend.id),
    observability: createRecordingObservability(),
    turnTimeoutMs: 120_000,
  }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 }));
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

type Mode = "pass" | "refuse";

/** The network between one browser context and the host. */
interface Net {
  mode: Mode;
  /** Server frames are dropped while this returns true. */
  dropServerFrame: (frame: { type?: string }) => boolean;
  /** Rewrites a server frame on its way to the page. */
  rewrite: (frame: Record<string, unknown>) => Record<string, unknown>;
  connections: number;
  live: Set<{ route: WebSocketRoute; blackholed: boolean }>;
  /** Close every open connection, as a dropped network would. */
  cut(): void;
  /** Stop forwarding on every open connection without closing it. */
  blackhole(): void;
  frames: Array<{ dir: "up" | "down"; type: string; at: number }>;
}

const networks = new WeakMap<BrowserContext, Net>();

async function newContext(hasTouch = false): Promise<{ context: BrowserContext; net: Net }> {
  const context = await browser!.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce", hasTouch });
  await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const net: Net = {
    mode: "pass",
    dropServerFrame: () => false,
    rewrite: (f) => f,
    connections: 0,
    live: new Set(),
    frames: [],
    cut() {
      for (const c of [...this.live]) {
        this.live.delete(c);
        void c.route.close({ code: 4001, reason: "offline" });
      }
    },
    blackhole() {
      for (const c of this.live) c.blackholed = true;
    },
  };
  await context.routeWebSocket(/\/ws$/, (route) => {
    if (net.mode === "refuse") {
      void route.close({ code: 4001, reason: "offline" });
      return;
    }
    net.connections++;
    const entry = { route, blackholed: false };
    net.live.add(entry);
    const upstream = route.connectToServer();
    route.onMessage((message) => {
      if (entry.blackholed) return;
      try {
        net.frames.push({ dir: "up", type: JSON.parse(String(message)).type, at: Date.now() });
      } catch {}
      upstream.send(message);
    });
    upstream.onMessage((message) => {
      if (entry.blackholed) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(message));
      } catch {
        route.send(message);
        return;
      }
      net.frames.push({ dir: "down", type: String(frame.type), at: Date.now() });
      if (net.dropServerFrame(frame)) return;
      route.send(JSON.stringify(net.rewrite(frame)));
    });
    route.onClose(() => net.live.delete(entry));
  });
  networks.set(context, net);
  return { context, net };
}

async function openPage(context: BrowserContext, holdPrincipalRead = false): Promise<Page> {
  const page = await context.newPage();
  await page.goto(holdPrincipalRead ? `${origin}/?holdPrincipalRead` : origin);
  await page.waitForFunction("window.__answers?.connected()");
  return page;
}

async function ask(page: Page, kind: Kind, command: string = kind): Promise<string> {
  const composer = page.locator("textarea.bk-composer");
  await composer.fill(command);
  // Connected transport can precede the validated draft-profile response.
  await page.waitForFunction(() => {
    const send = document.querySelector<HTMLElement>('[role="button"][aria-label="Send"]');
    const ready = send !== null && send.getAttribute("aria-disabled") !== "true" && send.getClientRects().length > 0;
    const control = (window as unknown as { __sendControl?: { waiting: boolean } }).__sendControl;
    if (!ready && control) control.waiting = true;
    return ready;
  });
  await composer.press("Enter");
  await page.waitForFunction("window.__answers.cards() === 1");
  return `toolu_${kind}_${sequence}`;
}

/** Answer the visible card as a user would, with a nonempty (multibyte where possible) answer. */
async function answer(page: Page, kind: Kind): Promise<void> {
  if (kind === "ask_user") {
    await page.getByText(HARBOUR, { exact: true }).click();
    await page.getByText("Submit", { exact: true }).click();
  } else if (kind === "ask_user_list") {
    await page.getByRole("radio", { name: "Pack, Rope", exact: true }).click();
    await page.getByRole("button", { name: "Submit 1", exact: true }).click();
  } else if (kind === "ask_user_rank") {
    await page.getByRole("button", { name: "Keep this order", exact: true }).click();
  } else {
    await page.getByRole("textbox", { name: "Supply note", exact: true }).fill(NOTE);
    await page.getByRole("button", { name: "Submit", exact: true }).click();
  }
}

async function waitForState(page: Page, requestId: string, wanted: string, timeout = 20_000) {
  try {
    await page.waitForFunction(
      ([id, s]) => (window as unknown as { __answers: { deliveries(): Record<string, { state: string }> } }).__answers.deliveries()[id!]?.state === s,
      [requestId, wanted],
      { timeout }
    );
  } catch (error) {
    const pages = page.context().pages();
    const tabs = await Promise.all(pages.map(async (tab, index) => ({
      tab: index,
      snapshot: await tab.evaluate(() =>
        (window as unknown as { __answers: { snapshot(): Promise<unknown> } }).__answers.snapshot()
      ).catch((e: Error) => ({ snapshotError: e.message })),
    })));
    const net = networks.get(page.context());
    console.error("[answer-state-timeout]", JSON.stringify({ requestId, wanted, requestedTab: pages.indexOf(page), tabs,
      settlements: settlements.get(requestId)?.length, network: net && {
        mode: net.mode, frames: net.frames, live: net.live.size, connections: net.connections,
      } }));
    throw error;
  }
}

const online = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

describe.skipIf(!executablePath)("answer delivery in a real browser", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [320, 1280]) {
      test(`1887: Other has explicit current-text Submit at ${width}px in ${theme}`, async () => {
        const { context, net } = await newContext(width === 320);
        try {
          const page = await openPage(context);
          // The delivery harness is otherwise deliberately unstyled. These
          // layout cases need the real built consumer and kit stylesheets.
          for (const css of ["../../ui-kit/dist/styles.css", "../dist/styles.css"]) {
            await page.addStyleTag({ content: await Bun.file(resolve(import.meta.dir, css)).text() });
          }
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
          expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "OTHER_LAYOUT_USES_REAL_THEME").toBe(theme);
          const id = await ask(page, "ask_user");
          await page.getByRole("radio", { name: /Other/ }).click();
          const field = page.getByRole("textbox", { name: "Your own answer", exact: true });
          const submit = page.getByRole("button", { name: "Submit", exact: true });
          await field.fill("Scheria — Σχερίη");
          expect(await submit.count(), "OTHER_CUSTOM_TEXT_HAS_EXPLICIT_SUBMIT").toBe(1);
          await field.fill("   ");
          expect(await submit.getAttribute("aria-disabled"), "BLANK_OTHER_SUBMIT_DISABLED").toBe("true");
          await field.press("Enter");
          expect(net.frames.filter(f => f.dir === "up" && f.type === "ask_user_response")).toHaveLength(0);
          await field.fill("Scheria — Σχερίη");
          // Editing survives switching away and back; the predefined choice
          // replaces Other in a single-select without submitting either draft.
          await page.getByRole("radio", { name: new RegExp(HARBOUR) }).click();
          expect(await field.count()).toBe(0);
          await page.getByRole("radio", { name: /Other/ }).click();
          expect(await field.inputValue()).toBe("Scheria — Σχερίη");
          await field.fill("Aeaea — Αἰαίη");
          await field.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          expect(await submit.evaluate(el => el === document.activeElement), "OTHER_SUBMIT_KEYBOARD_REACHABLE").toBe(true);
          expect(await submit.evaluate(el => el.getBoundingClientRect().height), "OTHER_SUBMIT_TOUCH_HEIGHT").toBeGreaterThanOrEqual(44);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "OTHER_CARD_NO_OVERFLOW").toBe(true);
          if (width === 320) await submit.tap();
          else await submit.press("Space");
          await waitForState(page, id, "answered");
          expect(settlements.get(id), "OTHER_CURRENT_TEXT_SETTLES_ORIGINAL_REQUEST_ONCE").toEqual([
            { answers: { "Which harbour first?": "Aeaea — Αἰαίη" } },
          ]);
          expect(net.frames.filter(f => f.dir === "up" && f.type === "ask_user_response")).toHaveLength(1);
        } finally { await context.close(); }
      });
    }
  }

  test("1887: multi-select Other retains predefined picks and refuses composing Enter", async () => {
    const { context, net } = await newContext();
    try {
      const page = await openPage(context);
      const id = await ask(page, "ask_user", "ask_user:multi");
      await page.getByRole("checkbox", { name: new RegExp(HARBOUR) }).click();
      await page.getByRole("checkbox", { name: /Other/ }).click();
      const field = page.getByRole("textbox", { name: "Your own answer", exact: true });
      await field.fill("Scheria — Σχερίη");
      await field.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      expect(net.frames.filter(f => f.dir === "up" && f.type === "ask_user_response"), "COMPOSING_ENTER_DOES_NOT_SUBMIT").toHaveLength(0);
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await waitForState(page, id, "answered");
      expect(settlements.get(id)).toEqual([{ answers: { "Which harbour first?": `${HARBOUR}, Scheria — Σχερίη` } }]);
    } finally { await context.close(); }
  });

  test("1887: Other Enter still submits a single answer once", async () => {
    const { context, net } = await newContext();
    try {
      const page = await openPage(context);
      const id = await ask(page, "ask_user");
      await page.getByRole("radio", { name: /Other/ }).click();
      const field = page.getByRole("textbox", { name: "Your own answer", exact: true });
      await field.fill("Scheria — Σχερίη");
      await field.press("Enter");
      await waitForState(page, id, "answered");
      expect(settlements.get(id)).toEqual([{ answers: { "Which harbour first?": "Scheria — Σχερίη" } }]);
      expect(net.frames.filter(f => f.dir === "up" && f.type === "ask_user_response")).toHaveLength(1);
    } finally { await context.close(); }
  });

  test("1887: grouped Other draft submits with the sibling answer without Enter", async () => {
    const { context } = await newContext();
    try {
      const page = await openPage(context);
      const id = await ask(page, "ask_user", "ask_user:group");
      await page.getByRole("radio", { name: /Other/ }).first().click();
      await page.getByRole("textbox", { name: "Your own answer, Harbour", exact: true }).fill("Scheria — Σχερίη");
      await page.getByRole("radio", { name: /Rope/ }).click();
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await waitForState(page, id, "answered");
      expect(settlements.get(id)).toEqual([{ answers: { "Which harbour first?": "Scheria — Σχερίη", "Which supplies?": "Rope" } }]);
    } finally { await context.close(); }
  });

  test("a first send waits for actual draft-profile facts, independently of connected transport", async () => {
    const { context, net } = await newContext();
    const requested = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    await context.route("**/api/drafts/*/profile", async route => {
      const response = await route.fetch();
      requested.resolve();
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    let asking: Promise<string> | undefined;
    try {
      const page = await openPage(context);
      await requested.promise;
      const composer = page.locator("textarea.bk-composer");
      await composer.fill("ask_user_rank");
      const unavailable = page.getByRole("button", { name: "Send — unavailable", exact: true });
      await unavailable.waitFor();
      expect(await unavailable.isDisabled(), "CONNECTED_WITH_REAL_PROFILE_RESPONSE_HELD").toBe(true);
      // An actual premature native Enter is correctly refused by the product.
      await composer.press("Enter");
      expect(net.frames.filter(frame => frame.dir === "up" && frame.type === "chat_message")).toHaveLength(0);
      expect(await page.evaluate<number>("window.__answers.cards()")).toBe(0);
      await page.evaluate(() => {
        const control = { waiting: false, keyup: false };
        Object.assign(window, { __sendControl: control });
        document.addEventListener("keyup", event => { if (event.key === "Enter") control.keyup = true; }, { once: true });
      });
      // The response is released only after the helper reaches its readiness
      // guard or its actual Enter completes. This orders the old lost-send
      // premise without a sleep or a weaker product gate.
      asking = ask(page, "ask_user_rank");
      void asking.catch(() => {});
      await page.waitForFunction(() => {
        const control = (window as unknown as { __sendControl: { waiting: boolean; keyup: boolean } }).__sendControl;
        return control.waiting || control.keyup;
      });
      const premature = await page.evaluate(() => {
        const control = (window as unknown as { __sendControl: { waiting: boolean; keyup: boolean } }).__sendControl;
        return control.keyup && !control.waiting;
      });
      release.resolve();
      if (premature) {
        await page.getByRole("button", { name: "Send", exact: true }).waitFor();
        expect(net.frames.filter(frame => frame.dir === "up" && frame.type === "chat_message"), "SHARED_HELPER_SENT_AFTER_PROFILE_READINESS").toHaveLength(1);
      }
      const requestId = await asking;
      await answer(page, "ask_user_rank");
      await waitForState(page, requestId, "answered");
      expect(net.frames.filter(frame => frame.dir === "up" && frame.type === "chat_message")).toHaveLength(1);
      expect(settlements.get(requestId)).toHaveLength(1);
      expect(settlements.get(requestId)![0]).toMatchObject(EXPECTED_RESULTS.ask_user_rank);
    } finally {
      release.resolve();
      await context.close();
      await asking?.catch(() => {});
    }
  });
  // The hello/restore race is kind-independent. The manager keeps all four
  // kinds x empty/stale reads; native online/reload adapters remain below.
  test("ask_user: a stored principal read completed after hello still permits the first offline queue", async () => {
    const { context, net } = await newContext();
    try {
      const page = await openPage(context, true);
      await page.waitForFunction("window.__answers.principalReadWaiting()");
      expect(await page.evaluate("window.__answers.storedPrincipal()")).toBeNull();
      const requestId = await ask(page, "ask_user");
      await page.evaluate("window.__answers.finishPrincipalRead()");
      net.mode = "refuse";
      net.cut();
      await page.waitForFunction("!window.__answers.connected()");
      await answer(page, "ask_user");
      // Observe either completed admission outcome so a broken real hello
      // hookup fails on queue authority instead of exhausting the queued wait.
      await page.waitForFunction((id) => {
        const state = (window as unknown as { __answers: { deliveries(): Record<string, { state: string }> } }).__answers.deliveries()[id]?.state;
        return state === "queued" || state === "notSaved";
      }, requestId);
      expect(await page.evaluate((id) =>
        (window as unknown as { __answers: { deliveries(): Record<string, { state: string }> } }).__answers.deliveries()[id]?.state,
      requestId), "REAL_HELLO_PRESERVES_OFFLINE_QUEUE_AUTHORITY").toBe("queued");
      await waitForState(page, requestId, "queued");
      expect(settlements.get(requestId)).toEqual([]);
      net.mode = "pass";
      await online(page);
      await waitForState(page, requestId, "answered");
      expect(settlements.get(requestId)).toHaveLength(1);
      expect(settlements.get(requestId)![0]).toMatchObject(EXPECTED_RESULTS.ask_user);
    } finally {
      await context.close();
    }
  });

  for (const kind of KINDS) {
    test(`${kind}: online, the card says Answered only after the host's receipt, and the backend gets it once`, async () => {
      const { context } = await newContext();
      try {
        const page = await openPage(context);
        const requestId = await ask(page, kind);
        await answer(page, kind);
        await waitForState(page, requestId, "answered");
        await page.getByText(`Completed ${kind}`, { exact: true }).first().waitFor();
        expect(settlements.get(requestId)).toHaveLength(1);
        expect(settlements.get(requestId)![0]).toMatchObject(EXPECTED_RESULTS[kind]);
        expect(await page.locator('[data-answer-delivery="answered"] h4').textContent()).toBe("ANSWERED");
        expect(await page.evaluate(() => (window as unknown as { __answers: { cards(): number } }).__answers.cards())).toBe(1);
      } finally {
        await context.close();
      }
    });

    test(`${kind}: submitted offline, reloaded, then reconnected: restored, revalidated and accepted once`, async () => {
      const { context, net } = await newContext();
      try {
        const page = await openPage(context);
        const requestId = await ask(page, kind);
        net.mode = "refuse";
        net.cut();
        await page.waitForFunction("!window.__answers.connected()");
        await answer(page, kind);
        await waitForState(page, requestId, "queued");
        expect(await page.locator('[data-answer-delivery="queued"] h4').textContent()).toBe("NOT SENT YET · SAVED ON THIS DEVICE");
        expect(settlements.get(requestId)).toEqual([]);

        // A reload while offline: the submitted answer comes back from this device.
        await page.reload();
        await page.waitForFunction("window.__answers !== undefined");
        await waitForState(page, requestId, "queued");
        const held = await page.evaluate(() => (window as unknown as { __answers: { held(): Array<{ submissionId: string; payload: unknown }> } }).__answers.held());
        expect(held).toHaveLength(1);
        expect(held[0]!.payload).toMatchObject({ kind, ...EXPECTED_RESULTS[kind] });
        expect(settlements.get(requestId)).toEqual([]);

        net.mode = "pass";
        await online(page);
        await waitForState(page, requestId, "answered");
        expect(settlements.get(requestId)).toHaveLength(1);
        expect(settlements.get(requestId)![0]).toMatchObject(EXPECTED_RESULTS[kind]);
        // Status before replay: the page asked before it answered again.
        const up = net.frames.filter((f) => f.dir === "up").map((f) => f.type);
        expect(up.indexOf("ask_answer_status")).toBeGreaterThan(-1);
        expect(up.indexOf("ask_answer_status")).toBeLessThan(up.lastIndexOf(`${kind}_response`));
        // One card for the request after history replay and re-delivery.
        await page.getByText(`Completed ${kind}`, { exact: true }).first().waitFor();
        expect(await page.evaluate(() => (window as unknown as { __answers: { cards(): number } }).__answers.cards())).toBe(1);
        expect(await page.evaluate(() => (window as unknown as { __answers: { held(): unknown[] } }).__answers.held())).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test("a receipt lost in flight resolves to Answered on the 5-second check, without a second settlement", async () => {
    const { context, net } = await newContext();
    let page: Page | undefined;
    type Snapshot = { sends: Array<{ id: number; type: string; requestId?: string; submissionId?: string; probeId?: string; timers: number[] }>;
      timers: Array<{ id: number; scope: number; delay: number; at: number; fired: number; clears: number }>; errors: number };
    const snapshot = () => page!.evaluate(() => (window as unknown as { __receiptTimers: { snapshot(): Snapshot } }).__receiptTimers.snapshot());
    const nativeWait = { polls: 0, waitedMs: 0 };
    const nativeUntil = async (ready: () => Promise<boolean>, label = "RECEIPT_NATIVE_COMPLETION_MISSING") => {
      const deadline = performance.now() + 5_000;
      while (!await ready()) {
        if (performance.now() >= deadline) throw new Error(label);
        const started = performance.now();
        await Bun.sleep(10);
        nativeWait.polls++; nativeWait.waitedMs += performance.now() - started;
      }
    };
    try {
      page = await context.newPage();
      await page.clock.install({ time: new Date("2026-07-12T12:00:00Z") });
      await page.goto(origin);
      await page.waitForFunction("window.__answers?.connected()");
      const requestId = await ask(page, "ask_user");
      await page.evaluate(installReceiptWatchdogObserver, requestId);
      let dropped = 0;
      const pongs: string[] = [], receipts: Array<{ requestId: unknown; submissionId: unknown; state: unknown }> = [];
      net.dropServerFrame = (f) => {
        const metadata = f as { probeId?: unknown; requestId?: unknown; submissionId?: unknown; state?: unknown };
        if (f.type === "pong" && typeof metadata.probeId === "string") pongs.push(metadata.probeId);
        if (f.type === "ask_answer_receipt") receipts.push({ requestId: metadata.requestId, submissionId: metadata.submissionId, state: metadata.state });
        return f.type === "ask_answer_receipt" && dropped++ === 0;
      };
      const wallStarted = performance.now();
      const started = await page.evaluate(() => Date.now());
      await answer(page, "ask_user");
      await waitForState(page, requestId, "awaiting");
      expect(await page.locator('[data-answer-delivery="awaiting"] h4').textContent()).toBe("SENT · WAITING FOR THE HOST");
      await nativeUntil(async () => dropped === 1);
      const initial = await snapshot();
      const answerSend = initial.sends.filter(s => s.type === "ask_user_response" && s.requestId === requestId);
      expect(answerSend, "ONE_NATIVE_ANSWER_SEND").toHaveLength(1);
      expect(answerSend[0]!.timers, "UNAMBIGUOUS_RECEIPT_TIMER_OWNER").toHaveLength(1);
      const first = initial.timers[answerSend[0]!.timers[0]!]!;
      expect(initial.errors, "RECEIPT_OBSERVER_VALID").toBe(0);
      expect(first.delay, "DEFAULT_RECEIPT_REGISTRATION").toBe(5_000);
      const remaining = first.at + 5_000 - await page.evaluate(() => Date.now());
      expect(remaining, "RECEIPT_CLOCK_PAUSED_BEFORE_DEADLINE").toBeGreaterThan(1);
      await page.clock.pauseAt(first.at + 5_000 - 1);
      expect((await snapshot()).timers[first.id]!.fired, "RECEIPT_NOT_EARLY").toBe(0);
      expect(net.frames.filter(f => f.dir === "up" && f.type === "ask_answer_status")).toHaveLength(0);
      expect(await page.evaluate(id => (window as unknown as { __answers: { deliveries(): Record<string, { state: string }> } }).__answers.deliveries()[id]?.state, requestId), "RECEIPT_STILL_AWAITING_BEFORE_DEADLINE").toBe("awaiting");
      await page.clock.runFor(1);
      expect((await snapshot()).timers[first.id]!.fired, "RECEIPT_AT_DEADLINE").toBe(1);
      await nativeUntil(async () => (await snapshot()).sends.some(s => s.type === "ask_answer_status" && s.requestId === requestId), "RECEIPT_STATUS_QUERY_MISSING");
      await nativeUntil(async () => page!.evaluate(id => (window as unknown as { __answers: { deliveries(): Record<string, { state: string }> } }).__answers.deliveries()[id]?.state === "answered", requestId));
      await waitForState(page, requestId, "answered", 15_000);
      const elapsed = await page.evaluate(() => Date.now()) - started;
      expect(dropped).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(settlements.get(requestId)).toHaveLength(1);
      const accepted = await snapshot();
      const status = accepted.sends.filter(s => s.type === "ask_answer_status" && s.requestId === requestId);
      expect(status).toHaveLength(1);
      expect(status[0]!.submissionId).toBe(answerSend[0]!.submissionId);
      expect(status[0]!.timers, "UNAMBIGUOUS_REARMED_TIMER_OWNER").toHaveLength(1);
      const rearmed = accepted.timers[status[0]!.timers[0]!]!;
      expect(rearmed.delay, "DEFAULT_REARMED_RECEIPT_REGISTRATION").toBe(5_000);
      expect(rearmed.clears, "ACCEPTED_RECEIPT_CANCELS_WATCHDOG").toBeGreaterThan(0);
      const ping = accepted.sends.filter(s => s.type === "ping");
      expect(ping, "RECEIPT_CALLBACK_PROBES_NATIVE_SOCKET").toHaveLength(1);
      expect(ping[0]!.timers, "UNAMBIGUOUS_LIVENESS_TIMER_OWNER").toHaveLength(1);
      await nativeUntil(async () => pongs.includes(ping[0]!.probeId!) && (await snapshot()).timers[ping[0]!.timers[0]!]!.clears > 0);
      expect(receipts).toEqual([
        { requestId, submissionId: answerSend[0]!.submissionId, state: "accepted" },
        { requestId, submissionId: answerSend[0]!.submissionId, state: "accepted" },
      ]);
      expect(net.connections, "CORRELATED_PONG_RETAINS_SOCKET").toBe(1);
      expect(await page.evaluate<boolean>("window.__answers.connected()")).toBe(true);
      await page.clock.runFor(5_001);
      const after = await snapshot();
      expect(after.timers[rearmed.id]!.fired, "NO_RETIRED_RECEIPT_CALLBACK").toBe(0);
      expect(after.sends.filter(s => s.type === "ask_answer_status")).toHaveLength(1);
      expect(after.sends.filter(s => s.type === "ask_user_response")).toHaveLength(1);
      expect(settlements.get(requestId)).toHaveLength(1);
      expect(after.errors, "RECEIPT_OBSERVER_VALID_AFTER_COMPLETION").toBe(0);
      console.log("[measure] lost receipt", JSON.stringify({ logicalMs: elapsed, nativeMs: performance.now() - wallStarted, ...nativeWait, timers: after }));
    } finally {
      try {
        if (page && !page.isClosed()) expect(await page.evaluate(() => (window as unknown as { __receiptTimers?: { dispose(): { restored: boolean; errors: number } } }).__receiptTimers?.dispose() ?? { restored: true, errors: 0 })).toEqual({ restored: true, errors: 0 });
      } finally { await context.close(); }
    }
  });

  test("a host without receipt support: Update needed, and nothing settles", async () => {
    const { context, net } = await newContext();
    net.rewrite = (f) => {
      if (f.type !== "server_hello") return f;
      const { askReceipts: _gone, ...capabilities } = f.capabilities as Record<string, boolean>;
      return { ...f, protocolRev: 4, capabilities };
    };
    try {
      const page = await openPage(context);
      const requestId = await ask(page, "ask_user_rank");
      await answer(page, "ask_user_rank");
      await waitForState(page, requestId, "update");
      expect(await page.locator('[data-answer-delivery="update"] h4').textContent()).toBe("CAN'T SEND · UPDATE NEEDED");
      await page.waitForTimeout(500);
      expect(settlements.get(requestId)).toEqual([]);
      expect(net.frames.some((f) => f.dir === "up" && f.type === "ask_user_rank_response")).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("storage that refuses writes: Not saved, nothing sent, the card stays editable", async () => {
    const { context, net } = await newContext();
    await context.addInitScript(() => {
      IDBFactory.prototype.open = function () {
        throw new DOMException("The storage is unavailable.", "UnknownError");
      };
    });
    try {
      const page = await openPage(context);
      const requestId = await ask(page, "ask_user_form");
      await answer(page, "ask_user_form");
      await waitForState(page, requestId, "notSaved");
      expect(await page.locator('[data-answer-delivery="notSaved"] h4').textContent()).toBe("NOT SAVED ON THIS DEVICE");
      expect(await page.getByRole("textbox", { name: "Supply note", exact: true }).inputValue()).toBe(NOTE);
      expect(net.frames.some((f) => f.dir === "up" && f.type === "ask_user_form_response")).toBe(false);
      expect(settlements.get(requestId)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a different principal on reconnect signs the queued answer out, unsent", async () => {
    const { context, net } = await newContext();
    try {
      const page = await openPage(context);
      const requestId = await ask(page, "ask_user_list");
      net.mode = "refuse";
      net.cut();
      await page.waitForFunction("!window.__answers.connected()");
      await answer(page, "ask_user_list");
      await waitForState(page, requestId, "queued");
      net.rewrite = (f) => (f.type === "server_hello" ? { ...f, principalKey: "another-principal-key00" } : f);
      net.mode = "pass";
      await online(page);
      await waitForState(page, requestId, "signedOut");
      expect(await page.locator('[data-answer-delivery="signedOut"] h4').textContent()).toBe("NOT SENT · SIGNED OUT");
      expect(net.frames.some((f) => f.dir === "up" && (f.type === "ask_user_list_response" || f.type === "ask_answer_status"))).toBe(false);
      expect(settlements.get(requestId)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("two tabs: one owns the queued answer, the other mirrors it read-only; the host settles it once", async () => {
    const { context, net } = await newContext();
    try {
      const a = await openPage(context);
      const requestId = await ask(a, "ask_user");
      const b = await openPage(context);
      await b.waitForFunction("window.__answers.cards() === 1");
      net.mode = "refuse";
      net.cut();
      await a.waitForFunction("!window.__answers.connected()");
      await answer(a, "ask_user");
      await waitForState(a, requestId, "queued");
      await waitForState(b, requestId, "queued");
      const mirror = await b.evaluate((id) => (window as unknown as { __answers: { deliveries(): Record<string, { mirror?: boolean }> } }).__answers.deliveries()[id]?.mirror, requestId);
      expect(mirror).toBe(true);
      expect(await b.locator('[data-answer-delivery="queued"]').getByRole("button", { name: "Cancel sending" }).count()).toBe(0);
      net.mode = "pass";
      await online(a);
      await online(b);
      await waitForState(a, requestId, "answered");
      await waitForState(b, requestId, "answered");
      expect(settlements.get(requestId)).toHaveLength(1);
      const answers = net.frames.filter((f) => f.dir === "up" && f.type === "ask_user_response");
      expect(answers).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("a corrupt stored answer is dropped on load and never sent", async () => {
    const { context, net } = await newContext();
    try {
      const page = await openPage(context);
      await page.evaluate(
        () =>
          new Promise<void>((done, fail) => {
            const req = indexedDB.open("odysseus-answers:answers", 1);
            req.onsuccess = () => {
              const tx = req.result.transaction("answers", "readwrite");
              tx.objectStore("answers").put({ v: 1, submissionId: "corrupt-1", requestId: "toolu_x", payload: { kind: "ask_user", answers: 7 } });
              tx.oncomplete = () => done();
              tx.onerror = () => fail(tx.error);
            };
            req.onerror = () => fail(req.error);
          })
      );
      await page.reload();
      await page.waitForFunction("window.__answers?.connected()");
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as unknown as { __answers: { held(): unknown[] } }).__answers.held())).toEqual([]);
      expect(net.frames.some((f) => f.dir === "up" && (f.type === "ask_user_response" || f.type === "ask_answer_status"))).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("Liveness B: a blackholed idle socket is probed after 15 s, replaced 5 s later, and resyncs", async () => {
    const { context, net } = await newContext();
    try {
      const page = await context.newPage();
      // Install before app timers exist. Native sockets, host, IndexedDB and
      // event delivery stay real; only this page's JS clock is controlled.
      await installPausedLivenessClock(page);
      await page.addInitScript(() => {
        const frames: Array<{ dir: string; type: string; probeId?: string; at: number }> = [];
        const NativeSocket = WebSocket;
        class ObservedSocket extends NativeSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener("message", event => {
              const frame = JSON.parse(event.data);
              // Record delivery only; the later page evaluation and synchronous
              // production handler establish the clock-advance barrier.
              queueMicrotask(() => frames.push({ dir: "down", type: frame.type, probeId: frame.probeId, at: Date.now() }));
            });
          }
          override send(data: Parameters<WebSocket["send"]>[0]) {
            if (typeof data === "string") {
              const frame = JSON.parse(data);
              frames.push({ dir: "up", type: frame.type, probeId: frame.probeId, at: Date.now() });
            }
            super.send(data);
          }
        }
        Object.assign(window, { WebSocket: ObservedSocket, __livenessFrames: frames });
      });
      await page.goto(origin);
      await page.waitForFunction("window.__answers?.connected()");
      // Give reconnect something real to resync, rather than inferring a
      // resync from a second transport opening on an empty chat.
      const requestId = await ask(page, "ask_user_rank");
      await answer(page, "ask_user_rank");
      await waitForState(page, requestId, "answered");
      await page.getByText("Completed ask_user_rank", { exact: true }).waitFor();
      const frames = () => page.evaluate(() => (window as unknown as {
        __livenessFrames: Array<{ dir: string; type: string; probeId?: string; at: number }>;
      }).__livenessFrames);
      // Each read is a separate page evaluation after native dispatch; the
      // current liveness/history handlers commit synchronously. The observer
      // microtask alone does not establish arbitrary async-handler completion.
      // Bun-side polling exits on the event (5s is only a failure cap).
      const nativeWait = { polls: 0, waitedMs: 0 };
      const observed = async (predicate: (observedFrames: Awaited<ReturnType<typeof frames>>) => boolean) => {
        const deadline = Date.now() + 5_000;
        while (!predicate(await frames())) {
          if (Date.now() >= deadline) throw new Error("Liveness native event did not complete");
          const started = performance.now();
          await Bun.sleep(10);
          nativeWait.polls++;
          nativeWait.waitedMs += performance.now() - started;
        }
      };
      // Reset through a real host frame, then test the full default interval.
      const statuses = (await frames()).filter(f => f.dir === "down" && f.type === "status").length;
      for (const entry of net.live) entry.route.send(JSON.stringify({ type: "status", status: "idle" }));
      await observed(fs => fs.filter(f => f.dir === "down" && f.type === "status").length > statuses);
      const pingCount = async () => (await frames()).filter(f => f.dir === "up" && f.type === "ping").length;
      const initialPings = await pingCount();
      await page.clock.runFor(14_999);
      expect(await pingCount(), "BROWSER_DEFAULT_IDLE_NOT_EARLY").toBe(initialPings);
      await page.clock.runFor(1);
      expect(await pingCount(), "BROWSER_DEFAULT_IDLE_AT_BOUNDARY").toBe(initialPings + 1);
      const ping = (await frames()).filter(f => f.dir === "up" && f.type === "ping").at(-1)!;
      await observed(fs => fs.some(f => f.dir === "down" && f.type === "pong" && f.probeId === ping.probeId));
      await page.clock.runFor(5_000);
      expect(net.connections, "CORRELATED_PONG_CANCELS_REPLACEMENT").toBe(1);

      net.blackhole();
      await page.clock.runFor(9_999);
      expect(await pingCount(), "PONG_RESETS_IDLE_CLOCK").toBe(initialPings + 1);
      await page.clock.runFor(1);
      expect(await pingCount(), "BLACKHOLED_PROBE_AT_IDLE_BOUNDARY").toBe(initialPings + 2);
      await page.clock.runFor(4_999);
      expect(net.connections, "BROWSER_RESPONSE_NOT_EARLY").toBe(1);
      const resumes = (await frames()).filter(f => f.dir === "up" && f.type === "session_resume").length;
      const historiesBefore = (await frames()).filter(f => f.dir === "down" && f.type === "session_history").length;
      await page.clock.runFor(1);
      await observed(fs => fs.filter(f => f.dir === "down" && f.type === "server_hello").length === 2);
      expect(net.connections, "BROWSER_RESPONSE_AT_BOUNDARY").toBe(2);
      await observed(fs => fs.filter(f => f.dir === "up" && f.type === "session_resume").length > resumes &&
        fs.filter(f => f.dir === "down" && f.type === "session_history").length > historiesBefore);
      expect(await page.evaluate<boolean>("window.__answers.connected()")).toBe(true);
      expect(settlements.get(requestId)).toHaveLength(1);
      console.log("[measure] liveness", JSON.stringify({ controlledMs: 35_000, ...nativeWait,
        guarantees: "native greeting, correlated pong and session resync" }));
    } finally {
      await context.close();
    }
  }, 60_000);
});
