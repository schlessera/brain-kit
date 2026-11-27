import { expect, test } from "bun:test";
import type { OutputSpeed, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createTurnBudgets } from "../src/brain/turn-budgets";
import { createUiDb } from "../src/db/client";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { WsHost } from "../src/ws/host";
import { handleChatMessage, runSession } from "../src/ws/run-session";
import type { WSContext as Socket } from "../src/ws/clients";
import { FAST_OUTPUT_RATES, fastOutputPricing } from "../src/pricing/fast-output";
import { createSessionCatalog, type SessionCatalog } from "../src/ws/session-catalog";
import { outputSpeedBilling } from "../src/ws/session-run/billing";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

const AUTHORIZATION = testAuthorization();

/** A catalog double that records speeds as the real one stores them: first write wins. */
function speedCatalog(stored: Record<string, OutputSpeed> = {}): SessionCatalog & { recorded: Array<[string, OutputSpeed]> } {
  const recorded: Array<[string, OutputSpeed]> = [];
  return {
    recorded,
    getStoredProviderId: () => null, getStoredBackendId: () => "fake", persistSession() {},
    persistSessionStub(sessionId, _prompt, _provider, _backend, _owner, _creator, speed) { if (speed) { recorded.push([sessionId, speed]); stored[sessionId] ??= speed; } },
    getStoredOutputSpeed: sessionId => stored[sessionId] ?? null,
  };
}

function setup(backend: AgentBackend, catalog: SessionCatalog) {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send(data) { sent.push(JSON.parse(data) as ServerMessage); } };
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, observability: createRecordingObservability(), turnTimeoutMs: 5_000 });
  host.clients.add(ws, AUTHORIZATION.principalId);
  return { host, sent, ws: ws as Socket };
}

// #4310 F1: the WebSocket chat path carries a new conversation's speed.
test("a new WebSocket chat requesting fast runs and stores fast; a message to a known session cannot change it", async () => {
  const requests: StartTurnRequest[] = [];
  const catalog = speedCatalog();
  const { host, ws } = setup(recordingBackend(true, requests, "ithaca-ws"), catalog);
  await handleChatMessage(host, ws, { authorization: AUTHORIZATION, text: "Odysseus sets sail.", attachments: [], outputSpeed: "fast" });
  for (let tries = 0; requests.length < 1 && tries < 200; tries++) await Bun.sleep(1);
  for (let tries = 0; catalog.recorded.length < 1 && tries < 200; tries++) await Bun.sleep(1);
  expect(requests[0]!.outputSpeed, "WS_NEW_CHAT_RUNS_FAST").toBe("fast");
  expect(catalog.recorded, "WS_NEW_CHAT_STORES_FAST").toEqual([["ithaca-ws", "fast"]]);
  for (let tries = 0; host.coordinator.bySession.has("ithaca-ws") && tries < 500; tries++) await Bun.sleep(1);
  await handleChatMessage(host, ws, { authorization: AUTHORIZATION, text: "Penelope asks.", attachments: [], sessionId: "ithaca-ws", outputSpeed: "standard" });
  for (let tries = 0; requests.length < 2 && tries < 200; tries++) await Bun.sleep(1);
  expect(requests[1]!.outputSpeed, "WS_RESUME_KEEPS_STORED_FAST").toBe("fast");
});

function recordingBackend(fastOutput: boolean, requests: StartTurnRequest[], announce?: string) {
  return makeFakeBackend({ id: "fake", capabilities: { fastOutput }, startTurn: async request => {
    requests.push(request);
    if (announce && !request.sessionId) request.bridge.emit({ type: "session_info", sessionId: announce, isNew: true });
  } });
}

test("a new session keeps its chosen speed, stores it once, and a resume runs at the stored speed whatever the client sends", async () => {
  const requests: StartTurnRequest[] = [];
  const catalog = speedCatalog();
  const { host } = setup(recordingBackend(true, requests, "ithaca-fast"), catalog);
  await runSession(host, { authorization: AUTHORIZATION, text: "Odysseus sets sail.", attachments: [], outputSpeed: "fast" });
  expect(requests[0]!.outputSpeed, "NEW_SESSION_RUNS_ITS_CHOSEN_SPEED").toBe("fast");
  expect(catalog.recorded, "NEW_SESSION_SPEED_IS_STORED").toEqual([["ithaca-fast", "fast"]]);
  await runSession(host, { authorization: AUTHORIZATION, text: "Penelope asks.", attachments: [], sessionId: "ithaca-fast", outputSpeed: "standard" });
  expect(requests[1]!.outputSpeed, "RESUME_KEEPS_STORED_SPEED").toBe("fast");
  expect(catalog.recorded, "RESUME_STORES_NOTHING").toHaveLength(1);
});

test("a new session without a choice is standard, and a session predating the choice passes no speed", async () => {
  const requests: StartTurnRequest[] = [];
  const { host } = setup(recordingBackend(true, requests), speedCatalog());
  await runSession(host, { authorization: AUTHORIZATION, text: "Odysseus sets sail.", attachments: [] });
  await runSession(host, { authorization: AUTHORIZATION, text: "Telemachus returns.", attachments: [], sessionId: "ithaca-old", outputSpeed: "fast" });
  expect(requests.map(request => request.outputSpeed), "DEFAULT_STANDARD_AND_LEGACY_UNSET").toEqual(["standard", undefined]);
});

test("a fast session on a backend without fast output is refused by name before it starts", async () => {
  const requests: StartTurnRequest[] = [];
  const { host, sent } = setup(recordingBackend(false, requests), speedCatalog());
  await runSession(host, { authorization: AUTHORIZATION, text: "Odysseus sets sail.", attachments: [], outputSpeed: "fast" });
  expect(requests, "UNSUPPORTED_FAST_NEVER_STARTS").toEqual([]);
  expect(sent.find(message => message.type === "error"), "UNSUPPORTED_FAST_NAMED").toMatchObject({ failure: { errorClass: "fast_output_unavailable" } });
});

// #4310 F8: the speed is part of the row's own write, never a separate one that can fail alone.
test("the session catalog stores the speed in the session row's own write and keeps the first", async () => {
  const db = createUiDb(":memory:");
  try {
    const catalog = createSessionCatalog(() => db, { emit() {} } as never);
    catalog.persistSessionStub("ithaca", "Odysseus sets sail.", null, "fake", undefined, undefined, "fast");
    expect(catalog.getStoredOutputSpeed!("ithaca"), "PENDING_SPEED_VISIBLE").toBe("fast");
    catalog.persistSessionStub("ithaca", "Odysseus sets sail.", null, "fake", undefined, undefined, "standard");
    catalog.persistSession({ type: "result", sessionId: "ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false } as never, "Odysseus sets sail.", null, "fake");
    await catalog.settled!();
    // A row whose write carries its speed has no state with a session and no speed.
    db.exec("CREATE TRIGGER no_separate_speed BEFORE UPDATE OF output_speed ON sessions BEGIN SELECT RAISE(ABORT, 'Scylla'); END");
    catalog.persistSessionStub("troy", "Achilles waits.", null, "fake", undefined, undefined, "fast");
    await catalog.settled!();
    expect((db.query("SELECT output_speed AS speed FROM sessions WHERE id = 'troy'").get() as { speed: string }).speed, "SPEED_WRITTEN_WITH_ROW").toBe("fast");
    expect(catalog.getStoredOutputSpeed!("ithaca"), "FIRST_SPEED_KEPT").toBe("fast");
    expect((db.query("SELECT output_speed AS speed FROM sessions WHERE id = 'ithaca'").get() as { speed: string }).speed, "COMMITTED_SPEED").toBe("fast");
    expect(catalog.getStoredOutputSpeed!("unknown"), "UNKNOWN_SESSION_HAS_NO_SPEED").toBeNull();
  } finally { db.close(); }
});

const opus = "claude-opus-5-5", fastInput = FAST_OUTPUT_RATES[opus]!.input;
const standard = { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const }) };

test("fast rates come from the runtime's table, unknown Claude models stay unpriced and other providers keep their rates", () => {
  expect(fastInput, "OPUS_FAST_INPUT_RATE").toBeCloseTo(8 / 1_000_000, 15);
  const fast = fastOutputPricing(standard);
  expect(fast.resolve(opus)?.output, "OPUS_FAST_OUTPUT_RATE").toBeCloseTo(40 / 1_000_000, 15);
  expect(fast.resolve("claude-sonnet-4-6"), "CLAUDE_WITHOUT_FAST_RATE_UNPRICED").toBeNull();
  expect(fast.resolve("gemini/gemini-3-flash-preview")?.input, "OTHER_PROVIDER_KEEPS_STANDARD").toBe(1);
});

test("a fast run is real spend at the fast rate on every billing mode, never zero and never a standard rate", () => {
  expect(outputSpeedBilling({ profileId: "claude", billingMode: "subscription" }, "fast"), "FAST_SUBSCRIPTION_BILLS_AS_SPEND").toEqual({ profileId: "claude", billingMode: "api", outputSpeed: "fast" });
  expect(outputSpeedBilling({ profileId: "claude", billingMode: "subscription" }, "standard")).toEqual({ profileId: "claude", billingMode: "subscription" });
  expect(outputSpeedBilling(undefined, "fast"), "FAST_WITHOUT_ROSTER_STILL_FAST_SPEND").toEqual({ billingMode: "api", outputSpeed: "fast" });
  expect(outputSpeedBilling(undefined, "standard")).toBeUndefined();
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test", pricing: standard });
    const run = (runId: string, attrs: Record<string, unknown>, model = opus) => {
      store.startSpan({ spanId: runId, runId, name: "invoke_agent", kind: "turn", origin: "session", sessionId: "ithaca", startedAt: Date.UTC(2026, 6, 12),
        attrs: { ...attrs, "gen_ai.usage.per_model": { [model]: { inputTokens: 2 } } } });
      store.endSpan(runId, { outcome: "success", endedAt: Date.UTC(2026, 6, 12) + 1000, usage: { model, inputTokens: 2 } });
      store.rollupRun(runId);
      return db.query("SELECT cost_usd AS list, effective_cost_usd AS effective FROM activity_run_rollups WHERE run_id = ?").get(runId) as { list: number | null; effective: number | null };
    };
    const fastApi = run("fast-api", { "brain.billing_mode": "api", "brain.output_speed": "fast" });
    expect(fastApi.effective!, "FAST_RUN_AT_FAST_RATE").toBeCloseTo(2 * fastInput, 15);
    expect(fastApi.list!).toBeCloseTo(2 * fastInput, 15);
    const fastSubscription = run("fast-subscription", { "brain.billing_mode": "subscription", "brain.output_speed": "fast" });
    expect(fastSubscription.effective!, "FAST_SUBSCRIPTION_IS_NEVER_ZERO").toBeCloseTo(2 * fastInput, 15);
    expect(run("fast-unknown", { "brain.billing_mode": "api", "brain.output_speed": "fast" }, "claude-sonnet-4-6"), "FAST_RUN_WITHOUT_FAST_RATE_IS_UNKNOWN").toEqual({ list: null, effective: null });
    expect(run("standard-subscription", { "brain.billing_mode": "subscription" }), "STANDARD_SUBSCRIPTION_UNCHANGED").toEqual({ list: 2, effective: 0 });
  } finally { db.close(); }
});

// #4310 F3: an interactive Claude turn's cost is computed by the host, so it must use the fast rate.
test("a fast Claude turn's accounted cost is the fast rate, not the catalog's standard rate", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test", pricing: standard });
    const catalog = createSessionCatalog(() => db, undefined, undefined, { pricing: standard, store });
    const evidence = { completed: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { [opus]: { inputTokens: 2 } } } } as never;
    expect(catalog.accountClaudeUsage!("ithaca", "claude", "turn-fast", evidence, false, { billingMode: "api", outputSpeed: "fast" })!, "FAST_TURN_COST_AT_FAST_RATE").toBeCloseTo(2 * fastInput, 15);
    expect(catalog.accountClaudeUsage!("ithaca", "claude", "turn-standard", evidence, false, { billingMode: "api" }), "STANDARD_TURN_UNCHANGED").toBe(2);
  } finally { db.close(); }
});

// #4310 F4/F5: fast spend counts toward every dollar cap, and an independent
// relayed completion in a fast turn keeps its standard rate.
test("a fast turn's usage is priced at the fast rate in every budget scope, and its relayed completions at their own rate", async () => {
  const db = createUiDb(":memory:");
  try {
    const budgets = createTurnBudgets(db, standard, () => Date.UTC(2026, 6, 12, 12));
    const policy = resolveGovernancePolicy({ schema_version: 1, budgets: { turn: { warn_usd: 1, block_usd: 2, block_tokens: 1_000_000_000 },
      session: { warn_usd: 3, block_usd: 4, block_tokens: 1_000_000_000 }, day: { warn_usd: 3, block_usd: 4, block_tokens: 1_000_000_000 } } });
    const usage = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { [opus]: { inputTokens: n } } });
    await budgets.begin("standard", "ithaca", policy);
    expect(budgets.listPrice("standard", usage(1)), "STANDARD_TURN_PRICED").toBe(1);
    await budgets.begin("fast", "ithaca-fast", policy, undefined, "fast");
    expect(budgets.listPrice("fast", usage(1))!, "FAST_TURN_AT_FAST_RATE").toBeCloseTo(fastInput, 15);
    // 300,000 fast tokens at $8/M is $2.40: the turn's $2 dollar cap blocks it.
    const observed = (await budgets.observe("fast", usage(300_000)))!;
    expect(observed.receipt.listPriceCostUsd!, "FAST_RECEIPT_PRICED").toBeCloseTo(2.4, 9);
    expect(observed.blocked?.scope, "FAST_TURN_DOLLAR_CAP_BLOCKS").toBe("turn");
    // A relayed Claude completion runs at standard speed: its standard rate, not unpriced.
    const completion = (await budgets.observeProvider("fast", { attemptId: "haiku-1", family: "anthropic", operation: "completions", origin: "https://api.anthropic.com",
      key: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5-20251001", outcome: "completed", status: 200, inlineMedia: false, usage: { inputTokens: 10, outputTokens: 5 } } as never))!;
    // 15 tokens at the standard fixture rate of $1 each, added to the turn's $2.40.
    expect(completion.receipt.scopes.find(scope => scope.scope === "turn")!.costUsd!, "RELAYED_COMPLETION_KEEPS_ITS_RATE").toBeCloseTo(2.4 + 15, 6);
  } finally { db.close(); }
});

// #4310 round 3 F7: a roster that cannot be read leaves billing unknown, but a
// fast turn still runs fast, so its accounted cost is priced at the fast rate.
test("a fast turn whose provider roster cannot be read is still accounted at the fast rate", async () => {
  const contexts: unknown[] = [];
  const catalog = { ...speedCatalog(), accountClaudeUsage(_session: string, _backend: string, _turn: string, _evidence: unknown, _resumed: boolean, context: unknown) { contexts.push(context); return 0.004; } };
  const backend = makeFakeBackend({ id: "fake", capabilities: { fastOutput: true }, startTurn: async request => {
    request.bridge.emit({ type: "session_info", sessionId: "ithaca-roster", isNew: true });
    request.bridge.activity?.({ kind: "claude_session_usage", completed: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      perModel: { "claude-opus-5-5": { inputTokens: 2 } } } } as never);
    request.bridge.emit({ type: "result", sessionId: "ithaca-roster", outcome: "success", durationMs: 1, numTurns: 1, isError: false } as never);
  } });
  const registry = createStaticBackendRegistry([backend], backend.id);
  const broken = { ...registry, listAllProviders: async () => { throw new Error("The Ithaca roster is unreadable."); } };
  const host = new WsHost({ registry: broken as never, catalog, observability: createRecordingObservability(), turnTimeoutMs: 5_000 });
  await runSession(host, { authorization: AUTHORIZATION, text: "Odysseus sets sail.", attachments: [], outputSpeed: "fast" });
  expect(contexts, "ROSTER_FAILURE_KEEPS_FAST_PRICING").toEqual([expect.objectContaining({ billingMode: "api", outputSpeed: "fast" })]);
});

// #4310 round 3 F9: the stored-speed read belongs to routing, so its failure
// settles every follow-up queued meanwhile and releases its authorization.
test("a failed stored-speed read on resume settles queued follow-ups and releases their leases", async () => {
  const requests: StartTurnRequest[] = [];
  const gate = Promise.withResolvers<void>();
  const catalog = { ...speedCatalog(), getStoredOutputSpeed() { throw new Error("The Ithaca catalog is unreadable."); } };
  const backend = recordingBackend(true, requests);
  const registry = createStaticBackendRegistry([backend], backend.id);
  const slow = { ...registry, getBackendForSession: async (id: string | null) => { await gate.promise; return registry.getBackendForSession(id); } };
  const host = new WsHost({ registry: slow as never, catalog, observability: createRecordingObservability(), turnTimeoutMs: 5_000 });
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send(data) { sent.push(JSON.parse(data) as ServerMessage); } };
  host.clients.add(ws, AUTHORIZATION.principalId);
  let retained = 0, released = 0;
  const authorization = { ...AUTHORIZATION, retain: () => { retained++; const release = AUTHORIZATION.retain(); return () => { released++; release(); }; } } as typeof AUTHORIZATION;
  const running = runSession(host, { authorization, text: "Penelope asks.", attachments: [], sessionId: "ithaca-broken" });
  for (let tries = 0; !host.coordinator.startingBySession.has("ithaca-broken") && tries < 200; tries++) await Bun.sleep(1);
  await handleChatMessage(host, ws as Socket, { authorization, text: "Telemachus follows up.", attachments: [], sessionId: "ithaca-broken" });
  gate.resolve();
  await running;
  expect(requests, "FAILED_READ_STARTS_NOTHING").toEqual([]);
  expect(host.coordinator.startingBySession.has("ithaca-broken") || host.coordinator.bySession.has("ithaca-broken"), "FAILED_READ_LEAVES_NO_SLOT").toBe(false);
  expect(sent.filter(message => message.type === "error").length, "FAILED_READ_REPORTED").toBeGreaterThan(0);
  for (let tries = 0; released < retained && tries < 200; tries++) await Bun.sleep(1);
  expect(retained, "FOLLOW_UP_WAS_QUEUED_DURING_ROUTING").toBeGreaterThan(0);
  expect(released, "EVERY_QUEUED_LEASE_RELEASED").toBe(retained);
});
