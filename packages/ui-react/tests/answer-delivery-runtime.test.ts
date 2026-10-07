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
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { AgentBackend, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
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

let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "";
let sequence = 0;
/** Every settlement the backend's tools received, by request id. */
const settlements = new Map<string, unknown[]>();
const histories = new Map<string, SessionHistoryMessage[]>();

beforeAll(async () => {
  if (!executablePath) return;
  const repo = resolve(import.meta.dir, "../../..");
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-answer-delivery-"));
  const brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  // Bundled from source (the `bun` export condition), so what runs is this
  // checkout's code, not a stale dist.
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/answer-delivery-client.ts")],
    target: "browser",
    conditions: ["bun"],
    outdir: assets,
    naming: "client.js",
  });
  if (!bundle.success) throw new Error(`Answer delivery client build failed: ${bundle.logs.join("\n")}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  const backend: AgentBackend = {
    id: "answers-scripted",
    capabilities: { resume: true, permissions: false, thinking: false, attachments: false, askUser: true, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "answers-scripted", label: "Local fixture" }],
    listSessions: async () => [],
    getHistory: async (sessionId) => histories.get(sessionId) ?? [],
    async startTurn({ prompt, bridge }) {
      const kind = prompt as Kind;
      const n = ++sequence;
      const sessionId = `odysseus-answers-${n}`;
      const requestId = `toolu_${kind}_${n}`;
      bridge.emit({ type: "session_info", sessionId, isNew: true });
      bridge.emit({ type: "tool_use_start", sessionId, toolUseId: requestId, toolName: TOOL[kind] });
      bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: requestId, toolName: TOOL[kind], input: INPUT[kind] });
      const call = { id: requestId, name: TOOL[kind], input: INPUT[kind] } as SessionHistoryMessage["toolCalls"][number];
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
            ? await bridge.askUser!(requestId, INPUT.ask_user.questions as never)
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
  app = await createApp({
    config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    staticRoot: assets,
    registry: createStaticBackendRegistry([backend], backend.id),
    observability: createRecordingObservability(),
    turnTimeoutMs: 120_000,
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 180_000);

afterEach(() => {
  app?.cancelActiveTurns();
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

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

async function newContext(): Promise<{ context: BrowserContext; net: Net }> {
  const context = await browser!.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
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
  return { context, net };
}

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__answers?.connected()");
  return page;
}

async function ask(page: Page, kind: Kind): Promise<string> {
  const composer = page.locator("textarea.bk-composer");
  await composer.fill(kind);
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
  await page.waitForFunction(
    ([id, s]) => (window as unknown as { __answers: { deliveries(): Record<string, { state: string }> } }).__answers.deliveries()[id!]?.state === s,
    [requestId, wanted],
    { timeout }
  );
}

const online = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

describe.skipIf(!executablePath)("answer delivery in a real browser", () => {
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
    try {
      const page = await openPage(context);
      const requestId = await ask(page, "ask_user");
      let dropped = 0;
      net.dropServerFrame = (f) => f.type === "ask_answer_receipt" && dropped++ === 0;
      const started = Date.now();
      await answer(page, "ask_user");
      await waitForState(page, requestId, "awaiting");
      expect(await page.locator('[data-answer-delivery="awaiting"] h4').textContent()).toBe("SENT · WAITING FOR THE HOST");
      await waitForState(page, requestId, "answered", 15_000);
      const elapsed = Date.now() - started;
      expect(dropped).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(settlements.get(requestId)).toHaveLength(1);
      console.log(`[measure] lost receipt recovered after ${elapsed} ms`);
    } finally {
      await context.close();
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
      const page = await openPage(context);
      const pingsBefore = () => net.frames.filter((f) => f.dir === "up" && f.type === "ping").length;
      // Healthy idle traffic: one probe per 15 s without other frames.
      const idleStart = Date.now();
      await page.waitForTimeout(16_500);
      const healthyPings = pingsBefore();
      expect(healthyPings).toBe(1);
      expect(net.frames.some((f) => f.dir === "down" && f.type === "pong")).toBe(true);
      expect(net.connections).toBe(1);

      net.blackhole();
      const cut = Date.now();
      await page.waitForFunction(() => true);
      const deadline = cut + 30_000;
      while (net.connections < 2 && Date.now() < deadline) await page.waitForTimeout(100);
      const replacedAfter = Date.now() - cut;
      expect(net.connections).toBe(2);
      // At most 15 s idle + 5 s for the pong, plus timer slack.
      expect(replacedAfter).toBeLessThan(15_000 + 5_000 + 2_000);
      await page.waitForFunction("window.__answers.connected()");
      // A routed socket is counted before its upstream handshake completes,
      // and connected() can still reflect the previous socket in that gap.
      // Observe the replacement host greeting within the same deadline.
      const helloCount = () => net.frames.filter((f) => f.dir === "down" && f.type === "server_hello").length;
      while (helloCount() < 2 && Date.now() < deadline) await page.waitForTimeout(100);
      expect(helloCount()).toBe(2);
      console.log(`[measure] idle ${Date.now() - idleStart} ms, ${healthyPings} probe(s) while healthy; blackhole replaced after ${replacedAfter} ms`);
    } finally {
      await context.close();
    }
  }, 60_000);
});
