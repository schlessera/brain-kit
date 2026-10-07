/**
 * Cross-backend handoff (#61), through the real socket path and both real
 * backend adapters with keyless scripted runtimes: Claude's SDK `query` is a
 * generator, pi's runtime is a scripted session. Covers creation, the
 * idempotent key under a dropped acknowledgement, failed creation and retry,
 * a pending approval that stays on its source, and the preparation run's
 * attribution.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../../ui-backend-claude/src/backend";
import { createPiBackend, type PiSessionLike } from "../../ui-backend-pi/src/backend";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore, type ActivityStore } from "../src/activity/store";
import { createActivityStream, type ActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { throughTurns } from "../src/ws/handoff";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { testPrincipal } from "./helpers/principal";

type Frame = Record<string, any>;

function socket(): WSContext & { frames: Frame[]; drop: boolean } {
  const s = {
    frames: [] as Frame[],
    drop: false,
    readyState: 1,
    close: () => {},
    send(data: string) { if (!s.drop) s.frames.push(JSON.parse(data)); },
  };
  return s as unknown as WSContext & { frames: Frame[]; drop: boolean };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** What one scripted runtime saw and how it should behave next. */
interface Script {
  prompts: string[];
  autonomous: boolean[];
  /** Fail the next interactive start before the runtime names a session. */
  failNext: boolean;
  /** Hold the next interactive start before it names a session. */
  hold?: Promise<void>;
  /** The preparation run's reply, cost (undefined = unknown) and pause. */
  summary: string;
  summaryCost?: number;
  summaryHold?: Promise<void>;
  /** Raise a permission request on the next interactive turn. */
  askPermission: boolean;
  sessions: number;
}

function newScript(): Script {
  return { prompts: [], autonomous: [], failNext: false, summary: "Odysseus is sailing home to Ithaca.", summaryCost: 0.03, askPermission: false, sessions: 0 };
}

/** Claude with its SDK query replaced by a generator: no network, no key. */
function claudeAdapter(brainPath: string, script: Script, sourceHistory: unknown[]): AgentBackend {
  const queryFn = ((params: { options?: Options }) => (async function* () {
    // The prompt stays unread: reading it would run the subscription gate,
    // which needs a real CLI handshake. `counted` records what was handed over.
    const nonpersistent = params.options?.persistSession === false;
    script.autonomous.push(nonpersistent);
    if (nonpersistent) {
      yield { type: "system", subtype: "init", session_id: "claude-prep" };
      await script.summaryHold;
      yield { type: "stream_event", session_id: "claude-prep", event: { type: "content_block_delta", delta: { type: "text_delta", text: script.summary } } };
      yield { type: "result", subtype: "success", session_id: "claude-prep", duration_ms: 1, num_turns: 1,
        ...(script.summaryCost !== undefined ? { total_cost_usd: script.summaryCost } : {}) };
      return;
    }
    await script.hold;
    if (script.failNext) { script.failNext = false; throw new Error("Claude runtime refused to start"); }
    const id = `claude-${++script.sessions}`;
    yield { type: "system", subtype: "init", session_id: id };
    if (script.askPermission) {
      script.askPermission = false;
      await params.options!.canUseTool!("mcp__brain__write", { path: "plans/ithaca.md" }, { signal: new AbortController().signal, toolUseID: "source-write" } as never);
    }
    yield { type: "stream_event", session_id: id, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Continuing." } } };
    yield { type: "result", subtype: "success", session_id: id, total_cost_usd: 0.01, duration_ms: 1, num_turns: 1 };
  })()) as unknown as typeof query;
  return createClaudeBackend({
    brainPath,
    queryFn,
    listSessionsFn: (async () => []) as never,
    getSessionMessagesFn: (async () => sourceHistory) as never,
  });
}

/** pi with its runtime replaced by scripted sessions: no network, no key. */
function piAdapter(brainPath: string, script: Script): AgentBackend {
  const session = (id: string): PiSessionLike => {
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    let cost = 0;
    return {
      sessionId: id,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(text: string) {
        script.prompts.push(text);
        script.autonomous.push(false);
        for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Continuing.", contentIndex: 0 } } as unknown as AgentSessionEvent);
        cost = 0.02;
      },
      async abort() {},
      getSessionStats: () => ({ cost }),
      dispose() {},
    };
  };
  return createPiBackend({
    brainPath,
    sessionDir: join(brainPath, ".pi-sessions"),
    model: "anthropic/claude-sonnet-4-5",
    sessionFactory: {
      newSession: async () => {
        await script.hold;
        if (script.failNext) { script.failNext = false; throw new Error("pi runtime refused to start"); }
        return session(`pi-${++script.sessions}`);
      },
      openSession: async () => { throw new Error("fixture does not resume"); },
    },
  } as never);
}

/** Count the starts that reach each real adapter. */
function counted(backend: AgentBackend, starts: StartTurnRequest[]): AgentBackend {
  return { ...backend, startTurn: (req) => { starts.push(req); return backend.startTurn(req); } };
}

interface Rig {
  host: WsHost;
  db: ReturnType<typeof createUiDb>;
  store: ActivityStore;
  stream: ActivityStream;
  brain: string;
  scripts: { claude: Script; pi: Script };
  starts: { claude: StartTurnRequest[]; pi: StartTurnRequest[] };
  open(): WSContext & { frames: Frame[]; drop: boolean };
  send(ws: WSContext, frame: Frame): void;
  close(ws: WSContext): void;
}

let teardown: (() => void) | null = null;
afterEach(() => { teardown?.(); teardown = null; });

const SOURCE_HISTORY = [
  { type: "user", message: { content: "Plan the return to Ithaca." } },
  { type: "assistant", message: { model: "fixture", content: [{ type: "text", text: "Sail past the Sirens, then Scylla." }] } },
  { type: "user", message: { content: "Who keeps the house meanwhile?" } },
  { type: "assistant", message: { model: "fixture", content: [{ type: "text", text: "Penelope, with Telemachus." }] } },
];

interface RigOptions {
  cap?: number;
  /** Hold the provider roster read (billing resolution) until released. */
  rosterHold?: () => Promise<void> | undefined;
  /** Replace the catalog's handoff write. */
  recordHandoff?: (fallback: NonNullable<ReturnType<typeof createSessionCatalog>["recordHandoff"]>) => ReturnType<typeof createSessionCatalog>["recordHandoff"];
}

function rig(options: RigOptions = {}): Rig {
  const brain = mkdtempSync(join(tmpdir(), "brain-handoff-"));
  mkdirSync(join(brain, "plans"), { recursive: true });
  writeFileSync(join(brain, "plans", "ithaca.md"), "# Ithaca\n");
  mkdirSync(join(brain, ".git"), { recursive: true });
  writeFileSync(join(brain, ".git", "config"), "");
  const scripts = { claude: newScript(), pi: newScript() };
  const starts = { claude: [] as StartTurnRequest[], pi: [] as StartTurnRequest[] };
  const claude = counted(claudeAdapter(brain, scripts.claude, SOURCE_HISTORY), starts.claude);
  const pi = counted(piAdapter(brain, scripts.pi), starts.pi);
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "handoff-test" });
  const stream = createActivityStream(store);
  const registry = createStaticBackendRegistry([claude, pi], "claude");
  const catalog = createSessionCatalog(() => db);
  if (options.recordHandoff) catalog.recordHandoff = options.recordHandoff(catalog.recordHandoff!.bind(catalog));
  const host = new WsHost({
    brainPath: brain,
    registry: options.rosterHold
      ? { ...registry, listAllProviders: async (o) => { await options.rosterHold!(); return registry.listAllProviders(o); } }
      : registry,
    catalog,
    activity: { store, stream },
    maxConcurrentSessions: () => options.cap ?? 4,
  });
  // One handler set per socket: each owns its connection state, like a real upgrade.
  const handlersFor = new Map<WSContext, ReturnType<typeof createWsHandlers>>();
  teardown = () => { host.coordinator.reset(); host.close(); stream.close(); db.close(); rmSync(brain, { recursive: true, force: true }); };
  return {
    host, db, store, stream, brain, scripts, starts,
    open() {
      const ws = socket();
      const handlers = createWsHandlers(host, testPrincipal());
      handlersFor.set(ws, handlers);
      handlers.onOpen(undefined as never, ws);
      return ws;
    },
    send(ws, frame) { handlersFor.get(ws)!.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws); },
    close(ws) { handlersFor.get(ws)!.onClose({ code: 1006 } as CloseEvent, ws); },
  };
}

/** A settled source session owned by `backendId`, as the catalog records one. */
function seedSource(r: Rig, backendId: "claude" | "pi", id = `source-${backendId}`): string {
  r.host.catalog.persistSessionStub(id, "Ithaca return", backendId === "claude" ? "claude" : "default", backendId);
  r.db.prepare("UPDATE sessions SET total_cost_usd = 0.5, num_turns = 4 WHERE id = ?").run(id);
  return id;
}

function row(r: Rig, id: string) {
  return r.db.query("SELECT id, total_cost_usd AS cost, num_turns AS turns, backend_id AS backendId, handoff_from AS handoffFrom, handoff_id AS handoffId FROM sessions WHERE id = ?").get(id) as
    { id: string; cost: number; turns: number; backendId: string; handoffFrom: string | null; handoffId: string | null } | null;
}

function handoffRows(r: Rig, handoffId: string) {
  return r.db.query("SELECT id FROM sessions WHERE handoff_id = ?").all(handoffId) as { id: string }[];
}

const PAIRS = [
  { source: "claude", destination: "pi", profile: "default" },
  { source: "pi", destination: "claude", profile: "claude" },
] as const;

for (const pair of PAIRS) describe(`${pair.source} → ${pair.destination}`, () => {
  function chat(sourceSessionId: string, handoffId: string, extra: Frame = {}): Frame {
    return {
      type: "chat_message",
      text: "Odysseus is sailing home; Penelope keeps the house.",
      providerId: pair.profile,
      requestId: `req-${handoffId}`,
      handoff: { handoffId, sourceSessionId, references: ["plans/ithaca.md"] },
      ...extra,
    };
  }

  test("creates a distinct linked session whose first message is exactly the reviewed text plus references", async () => {
    const r = rig();
    const source = seedSource(r, pair.source);
    const ws = r.open();
    r.send(ws, chat(source, "h-create-0001"));
    await until(() => ws.frames.some((f) => f.type === "result"));

    const info = ws.frames.find((f) => f.type === "session_info")!;
    expect(info.backendId).toBe(pair.destination);
    expect(info.requestId).toBe("req-h-create-0001");
    expect(info.sessionId).not.toBe(source);
    expect(r.starts[pair.destination]).toHaveLength(1);
    expect(r.starts[pair.source]).toHaveLength(0);
    const expected = "Odysseus is sailing home; Penelope keeps the house.\n\nReferences:\n- plans/ithaca.md";
    expect(r.starts[pair.destination].map((start) => start.prompt)).toEqual([expected]);
    if (pair.destination === "pi") expect(r.scripts.pi.prompts).toEqual([expected]);

    const destination = row(r, info.sessionId)!;
    expect(destination).toMatchObject({ backendId: pair.destination, handoffFrom: source, handoffId: "h-create-0001" });
    // Its own turn only: no historical totals copied across.
    expect(destination.turns).toBe(1);
    expect(destination.cost).toBeCloseTo(pair.destination === "claude" ? 0.01 : 0.02, 6);
    // The source is untouched in every field this flow could reach.
    expect(row(r, source)).toMatchObject({ cost: 0.5, turns: 4, backendId: pair.source, handoffFrom: null, handoffId: null });
    const sourceRow = r.db.query("SELECT source FROM message_sources WHERE session_id = ?").get(info.sessionId) as { source: string } | null;
    expect(sourceRow?.source).toBe("handoff");
  });

  test("a dropped acknowledgement is recovered by status, and a retry with the same key never creates a second session or turn", async () => {
    const r = rig();
    const source = seedSource(r, pair.source);
    const first = r.open();
    const greeted = first.frames.length;
    first.drop = true; // the ack and every frame after it are lost
    r.send(first, chat(source, "h-dropped-0001"));
    await until(() => handoffRows(r, "h-dropped-0001").length === 1 && !r.host.coordinator.isTurnActive());
    expect(first.frames).toHaveLength(greeted);
    r.close(first);

    const second = r.open();
    r.send(second, { type: "handoff_status", handoffId: "h-dropped-0001" });
    await until(() => second.frames.some((f) => f.type === "handoff_receipt"));
    const created = handoffRows(r, "h-dropped-0001")[0]!.id;
    expect(second.frames.find((f) => f.type === "handoff_receipt")).toEqual({ type: "handoff_receipt", handoffId: "h-dropped-0001", state: "created", sessionId: created });

    r.send(second, chat(source, "h-dropped-0001"));
    await until(() => second.frames.filter((f) => f.type === "handoff_receipt").length === 2);
    expect(second.frames.at(-1)).toEqual({ type: "handoff_receipt", handoffId: "h-dropped-0001", state: "created", sessionId: created });
    expect(r.starts[pair.destination]).toHaveLength(1);
    expect(r.scripts[pair.destination].sessions).toBe(1);
    expect(handoffRows(r, "h-dropped-0001")).toHaveLength(1);
    expect(second.frames.some((f) => f.type === "session_info")).toBe(false);
  });

  test("a retry racing an unacknowledged creation answers pending and starts nothing", async () => {
    const r = rig();
    const source = seedSource(r, pair.source);
    const held = gate();
    r.scripts[pair.destination].hold = held.promise;
    const ws = r.open();
    r.send(ws, chat(source, "h-racing-0001"));
    await until(() => r.starts[pair.destination].length === 1);
    r.send(ws, chat(source, "h-racing-0001"));
    r.send(ws, { type: "handoff_status", handoffId: "h-racing-0001" });
    await until(() => ws.frames.filter((f) => f.type === "handoff_receipt").length === 2);
    expect(ws.frames.filter((f) => f.type === "handoff_receipt").map((f) => f.state)).toEqual(["pending", "pending"]);
    held.open();
    await until(() => ws.frames.some((f) => f.type === "result"));
    r.send(ws, { type: "handoff_status", handoffId: "h-racing-0001" });
    await until(() => ws.frames.filter((f) => f.type === "handoff_receipt").length === 3);
    expect(ws.frames.at(-1)).toMatchObject({ state: "created", sessionId: handoffRows(r, "h-racing-0001")[0]!.id });
    expect(r.starts[pair.destination]).toHaveLength(1);
    expect(handoffRows(r, "h-racing-0001")).toHaveLength(1);
  });

  test("a failed creation leaves nothing behind, and Try again creates exactly one session", async () => {
    const r = rig();
    const source = seedSource(r, pair.source);
    r.scripts[pair.destination].failNext = true;
    const ws = r.open();
    r.send(ws, chat(source, "h-failed-0001"));
    await until(() => ws.frames.some((f) => f.type === "error" && f.requestId === "req-h-failed-0001") && !r.host.coordinator.isTurnActive());
    expect(handoffRows(r, "h-failed-0001")).toHaveLength(0);
    r.send(ws, { type: "handoff_status", handoffId: "h-failed-0001" });
    await until(() => ws.frames.some((f) => f.type === "handoff_receipt"));
    expect(ws.frames.find((f) => f.type === "handoff_receipt")).toEqual({ type: "handoff_receipt", handoffId: "h-failed-0001", state: "none" });
    expect(row(r, source)).toMatchObject({ cost: 0.5, turns: 4, handoffFrom: null });

    r.send(ws, chat(source, "h-failed-0001"));
    await until(() => ws.frames.some((f) => f.type === "result"));
    expect(handoffRows(r, "h-failed-0001")).toHaveLength(1);
    expect(r.starts[pair.destination]).toHaveLength(2);
    expect(r.scripts[pair.destination].sessions).toBe(1);
  });

  test("refuses before starting anything: own backend, unknown source, unreadable or missing references, over-long text, an existing session", async () => {
    const r = rig();
    const source = seedSource(r, pair.source);
    const ws = r.open();
    const sameBackend = pair.source === "claude" ? "claude" : "default";
    const cases: Frame[] = [
      chat(source, "h-refuse-0001", { providerId: sameBackend }),
      chat("not-a-session", "h-refuse-0002"),
      chat(source, "h-refuse-0003", { handoff: { handoffId: "h-refuse-0003", sourceSessionId: source, references: [".git/config"] } }),
      chat(source, "h-refuse-0004", { handoff: { handoffId: "h-refuse-0004", sourceSessionId: source, references: ["plans/penelope.md"] } }),
      chat(source, "h-refuse-0005", { handoff: { handoffId: "h-refuse-0005", sourceSessionId: source, references: ["../outside.md"] } }),
      chat(source, "h-refuse-0006", { text: "x".repeat(4001) }),
      chat(source, "h-refuse-0007", { sessionId: source }),
    ];
    for (const frame of cases) r.send(ws, frame);
    await until(() => ws.frames.filter((f) => f.code === "HANDOFF_REJECTED").length === cases.length);
    const messages = Object.fromEntries(ws.frames.filter((f) => f.code === "HANDOFF_REJECTED").map((f) => [f.requestId, f.message]));
    expect(messages["req-h-refuse-0001"]).toContain("own backend");
    expect(messages["req-h-refuse-0002"]).toContain("isn't known");
    expect(messages["req-h-refuse-0003"]).toContain(".git/config");
    expect(messages["req-h-refuse-0004"]).toContain("plans/penelope.md");
    expect(messages["req-h-refuse-0005"]).toContain("../outside.md");
    expect(messages["req-h-refuse-0006"]).toContain("4000");
    expect(messages["req-h-refuse-0007"]).toContain("new chat");
    expect(r.starts.claude.length + r.starts.pi.length).toBe(0);
    expect(r.host.coordinator.handoffs.size).toBe(0);
  });
});

describe("approvals and running work stay on the source", () => {
  test("a pending source approval is untouched by a handoff and still answerable afterwards", async () => {
    const r = rig();
    r.scripts.claude.askPermission = true;
    const ws = r.open();
    r.send(ws, { type: "chat_message", text: "Write the plan down.", providerId: "claude" });
    await until(() => ws.frames.some((f) => f.type === "tool_approval_request"));
    const source = ws.frames.find((f) => f.type === "session_info")!.sessionId as string;
    const pending = [...r.host.coordinator.pendingApprovals.values()];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.turn.sessionId).toBe(source);

    r.send(ws, { type: "chat_message", text: "Write the plan down later.", providerId: "default", requestId: "req-approve",
      handoff: { handoffId: "h-approval-0001", sourceSessionId: source, references: [] } });
    await until(() => handoffRows(r, "h-approval-0001").length === 1 && r.host.coordinator.running.size === 1);
    // Same request, same turn, still pending; nothing of it reached pi.
    expect([...r.host.coordinator.pendingApprovals.values()]).toEqual(pending);
    expect(r.scripts.pi.prompts).toEqual(["Write the plan down later."]);
    expect(ws.frames.filter((f) => f.type === "tool_approval_request").map((f) => f.sessionId)).toEqual([source]);

    r.send(ws, { type: "tool_denial", toolUseId: "source-write", message: "Not yet.", turnId: pending[0]!.turnId });
    await until(() => !r.host.coordinator.isTurnActive());
    expect(r.host.coordinator.pendingApprovals.size).toBe(0);
  });
});

describe("handoff preparation", () => {
  test("runs one nonpersistent, toolless summary on the source's backend, attributed and priced on the source", async () => {
    const r = rig();
    const source = seedSource(r, "claude");
    const ws = r.open();
    r.send(ws, { type: "handoff_prepare", handoffId: "h-prepare-0001", sourceSessionId: source, turns: 1 });
    await until(() => ws.frames.some((f) => f.type === "handoff_draft"));
    const draft = ws.frames.find((f) => f.type === "handoff_draft")!;
    expect(draft).toMatchObject({ handoffId: "h-prepare-0001", state: "ready", text: "Odysseus is sailing home to Ithaca.", costUsd: 0.03 });

    expect(r.starts.claude).toHaveLength(1);
    const start = r.starts.claude[0]!;
    expect(start.sessionId).toBeUndefined();
    expect(start.autonomous).toMatchObject({ origin: "autonomous", persistence: "none", allowedTools: [] });
    expect(start).toMatchObject({ enforceAllowedTools: true, noGrantSurface: true, profileId: "claude" });
    expect(r.scripts.claude.autonomous).toEqual([true]);
    // The snapshot boundary: only the first turn reaches the model.
    expect(start.prompt).toContain("Plan the return to Ithaca.");
    expect(start.prompt).toContain("Sail past the Sirens");
    expect(start.prompt).not.toContain("Penelope");
    expect(r.starts.pi).toHaveLength(0);

    // One run on the source session, named for what it was, with its cost.
    const run = r.db.query("SELECT name, session_id AS sessionId, cost_usd AS cost, outcome FROM activity_run_rollups WHERE run_id = ?").get(draft.runId) as
      { name: string; sessionId: string; cost: number | null; outcome: string } | null;
    expect(run).toEqual({ name: "handoff preparation", sessionId: source, cost: 0.03, outcome: "success" });
    // The cost joins the source's total; it is not a turn of its conversation.
    expect(row(r, source)).toMatchObject({ turns: 4 });
    expect(row(r, source)!.cost).toBeCloseTo(0.53, 6);
    expect(r.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  });

  test("an unknown cost stays unknown, never $0", async () => {
    const r = rig();
    const source = seedSource(r, "claude");
    r.scripts.claude.summaryCost = undefined;
    const ws = r.open();
    r.send(ws, { type: "handoff_prepare", handoffId: "h-unknown-0001", sourceSessionId: source, turns: 2 });
    await until(() => ws.frames.some((f) => f.type === "handoff_draft"));
    const draft = ws.frames.find((f) => f.type === "handoff_draft")!;
    expect(draft.state).toBe("ready");
    expect("costUsd" in draft).toBe(false);
    const run = r.db.query("SELECT cost_usd AS cost FROM activity_run_rollups WHERE run_id = ?").get(draft.runId) as { cost: number | null };
    expect(run.cost).toBeNull();
    expect(row(r, source)!.cost).toBe(0.5);
  });

  test("stopping the run answers cancelled; a disconnect aborts it", async () => {
    const r = rig();
    const source = seedSource(r, "claude");
    const held = gate();
    r.scripts.claude.summaryHold = held.promise;
    const ws = r.open();
    r.send(ws, { type: "handoff_prepare", handoffId: "h-stop-00001", sourceSessionId: source, turns: 2 });
    await until(() => r.host.coordinator.handoffPreparations.size === 1 && r.starts.claude.length === 1);
    r.send(ws, { type: "handoff_prepare_cancel", handoffId: "h-stop-00001" });
    held.open();
    await until(() => ws.frames.some((f) => f.type === "handoff_draft"));
    expect(ws.frames.find((f) => f.type === "handoff_draft")).toMatchObject({ state: "cancelled" });
    expect(r.host.coordinator.handoffPreparations.size).toBe(0);

    const again = gate();
    r.scripts.claude.summaryHold = again.promise;
    const other = r.open();
    r.send(other, { type: "handoff_prepare", handoffId: "h-stop-00002", sourceSessionId: source, turns: 2 });
    await until(() => r.starts.claude.length === 2);
    const signal = r.starts.claude[1]!.signal;
    r.close(other);
    expect(signal.aborted).toBe(true);
    again.open();
  });

  test("a backend that cannot run a nonpersistent summary answers failed, and nothing runs", async () => {
    const r = rig();
    const source = seedSource(r, "pi");
    const ws = r.open();
    r.send(ws, { type: "handoff_prepare", handoffId: "h-pi-000001", sourceSessionId: source, turns: 2 });
    await until(() => ws.frames.some((f) => f.type === "handoff_draft"));
    expect(ws.frames.find((f) => f.type === "handoff_draft")).toMatchObject({ state: "failed", message: "pi can't draft a summary on this server." });
    expect(r.starts.pi.length + r.starts.claude.length).toBe(0);
    expect(r.db.query("SELECT COUNT(*) AS n FROM activity_run_rollups").get()).toEqual({ n: 0 });
  });
});

describe("review findings: authority, admission and fail-closed idempotency", () => {
  test("a principal revoked while billing resolves never starts the summary model", async () => {
    let hold: Promise<void> | undefined;
    const r = rig({ rosterHold: () => hold });
    const source = seedSource(r, "claude");
    const ws = r.open();
    const roster = gate();
    hold = roster.promise;
    r.send(ws, { type: "handoff_prepare", handoffId: "h-revoke-0001", sourceSessionId: source, turns: 2 });
    await until(() => r.host.coordinator.handoffPreparations.size === 1);
    await Bun.sleep(20); // history read done; now parked in billing resolution
    r.host.revokePrincipals(["test-principal"], 4001, "revoked");
    roster.open();
    await until(() => r.host.coordinator.handoffPreparations.size === 0);
    expect(r.starts.claude).toHaveLength(0);
  });

  test("a running preparation counts against the session cap for ordinary chat", async () => {
    const r = rig({ cap: 1 });
    const source = seedSource(r, "claude");
    const held = gate();
    r.scripts.claude.summaryHold = held.promise;
    const ws = r.open();
    r.send(ws, { type: "handoff_prepare", handoffId: "h-capped-0001", sourceSessionId: source, turns: 2 });
    await until(() => r.starts.claude.length === 1);
    r.send(ws, { type: "chat_message", text: "Meanwhile, the harbour fees?", providerId: "default", requestId: "req-capped" });
    await until(() => ws.frames.some((f) => f.requestId === "req-capped"));
    expect(ws.frames.find((f) => f.requestId === "req-capped")).toMatchObject({ type: "error", code: "SESSION_LIMIT" });
    expect(r.starts.pi).toHaveLength(0);
    held.open();
  });

  test("a disconnect aborts the run but keeps its slot until the backend has unwound", async () => {
    const r = rig({ cap: 1 });
    const source = seedSource(r, "claude");
    const held = gate();
    r.scripts.claude.summaryHold = held.promise;
    const first = r.open();
    r.send(first, { type: "handoff_prepare", handoffId: "h-unwind-0001", sourceSessionId: source, turns: 2 });
    await until(() => r.starts.claude.length === 1);
    r.close(first);
    expect(r.starts.claude[0]!.signal.aborted).toBe(true);
    expect(r.host.coordinator.handoffPreparations.size).toBe(1);
    const second = r.open();
    r.send(second, { type: "handoff_prepare", handoffId: "h-unwind-0002", sourceSessionId: source, turns: 2 });
    await until(() => second.frames.some((f) => f.type === "handoff_draft"));
    expect(second.frames.find((f) => f.type === "handoff_draft")).toMatchObject({ state: "failed", message: "The server is busy, so no summary was drafted." });
    held.open();
    await until(() => r.host.coordinator.handoffPreparations.size === 0);
  });

  for (const pair of PAIRS) test(`${pair.source} → ${pair.destination}: a destination whose link could not be stored is still found by its key`, async () => {
    const r = rig({ recordHandoff: () => () => false });
    const source = seedSource(r, pair.source);
    const ws = r.open();
    const frame = { type: "chat_message", text: "Odysseus is sailing home.", providerId: pair.profile, requestId: "req-unrecorded",
      handoff: { handoffId: "h-unrecorded-01", sourceSessionId: source, references: [] } };
    r.send(ws, frame);
    await until(() => ws.frames.some((f) => f.type === "result") && !r.host.coordinator.isTurnActive());
    const created = ws.frames.find((f) => f.type === "session_info")!.sessionId;
    r.send(ws, { type: "handoff_status", handoffId: "h-unrecorded-01" });
    r.send(ws, { ...frame, requestId: "req-unrecorded-2" });
    await until(() => ws.frames.filter((f) => f.type === "handoff_receipt").length === 2);
    expect(ws.frames.filter((f) => f.type === "handoff_receipt").map((f) => [f.state, f.sessionId])).toEqual([["created", created], ["created", created]]);
    expect(r.starts[pair.destination]).toHaveLength(1);
  });
});

describe("the snapshot boundary counts turns", () => {
  test("a reply replayed as several assistant steps stays whole", () => {
    const m = (role: "user" | "assistant", content: string) => ({ role, content, toolCalls: [] });
    // pi replays each model call of one reply; a live client shows one bubble.
    const history = [m("user", "Plan the return."), m("assistant", "Reading the chart."), m("assistant", "Sirens, then Scylla."), m("user", "Who keeps the house?"), m("assistant", "Penelope.")];
    expect(throughTurns(history, 1).map((x) => x.content)).toEqual(["Plan the return.", "Reading the chart.", "Sirens, then Scylla."]);
    expect(throughTurns(history, 2)).toHaveLength(5);
    expect(throughTurns(history, 0)).toEqual([]);
  });
});
