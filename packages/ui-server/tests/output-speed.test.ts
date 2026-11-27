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
import { runSession } from "../src/ws/run-session";
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
    getStoredProviderId: () => null, getStoredBackendId: () => "fake", persistSessionStub() {}, persistSession() {},
    recordOutputSpeed(sessionId, speed) { recorded.push([sessionId, speed]); stored[sessionId] ??= speed; },
    getStoredOutputSpeed: sessionId => stored[sessionId] ?? null,
  };
}

function setup(backend: AgentBackend, catalog: SessionCatalog) {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send(data) { sent.push(JSON.parse(data) as ServerMessage); } };
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, observability: createRecordingObservability(), turnTimeoutMs: 5_000 });
  host.clients.add(ws, AUTHORIZATION.principalId);
  return { host, sent };
}

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

test("the session catalog keeps the first stored speed", async () => {
  const db = createUiDb(":memory:");
  try {
    const catalog = createSessionCatalog(() => db, { emit() {} } as never);
    catalog.persistSessionStub("ithaca", "Odysseus sets sail.", null, "fake");
    catalog.recordOutputSpeed!("ithaca", "fast");
    expect(catalog.getStoredOutputSpeed!("ithaca"), "PENDING_SPEED_VISIBLE").toBe("fast");
    catalog.recordOutputSpeed!("ithaca", "standard");
    await catalog.settled!();
    expect(catalog.getStoredOutputSpeed!("ithaca"), "FIRST_SPEED_KEPT").toBe("fast");
    expect((db.query("SELECT output_speed AS speed FROM sessions WHERE id = 'ithaca'").get() as { speed: string }).speed, "COMMITTED_SPEED").toBe("fast");
    expect(catalog.getStoredOutputSpeed!("unknown"), "UNKNOWN_SESSION_HAS_NO_SPEED").toBeNull();
  } finally { db.close(); }
});

test("a fast run is real spend at the backend's fast price on every billing mode, never zero and never a standard rate", () => {
  expect(outputSpeedBilling({ profileId: "claude", billingMode: "subscription" }, "fast"), "FAST_SUBSCRIPTION_BILLS_AS_SPEND").toEqual({ profileId: "claude", billingMode: "api" });
  expect(outputSpeedBilling({ profileId: "claude", billingMode: "subscription" }, "standard")).toEqual({ profileId: "claude", billingMode: "subscription" });
  expect(outputSpeedBilling(undefined, "fast")).toBeUndefined();
  const db = createUiDb(":memory:");
  try {
    // Standard rates the host knows; a fast run must not use them.
    const store = createActivityStore(db, { writer: "test", pricing: { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" }) } });
    const run = (runId: string, attrs: Record<string, unknown>, costUsd: number | undefined) => {
      store.startSpan({ spanId: runId, runId, name: "invoke_agent", kind: "turn", origin: "session", sessionId: "ithaca", startedAt: Date.UTC(2026, 6, 12),
        attrs: { ...attrs, "gen_ai.usage.per_model": { "claude-opus-5-5": { inputTokens: 2 } } } });
      store.endSpan(runId, { outcome: "success", endedAt: Date.UTC(2026, 6, 12) + 1000, usage: { model: "claude-opus-5-5", inputTokens: 2, ...(costUsd !== undefined ? { costUsd } : {}) } });
      store.rollupRun(runId);
      return db.query("SELECT cost_usd AS list, effective_cost_usd AS effective FROM activity_run_rollups WHERE run_id = ?").get(runId);
    };
    expect(run("fast-api", { "brain.billing_mode": "api", "brain.output_speed": "fast" }, 0.004), "FAST_RUN_COSTS_BACKEND_FAST_PRICE").toEqual({ list: 0.004, effective: 0.004 });
    expect(run("fast-unreported", { "brain.billing_mode": "api", "brain.output_speed": "fast" }, undefined), "FAST_RUN_WITHOUT_BACKEND_COST_IS_UNKNOWN").toEqual({ list: null, effective: null });
    expect(run("fast-subscription", { "brain.billing_mode": "subscription", "brain.output_speed": "fast" }, 0.004), "FAST_SUBSCRIPTION_IS_NEVER_ZERO").toEqual({ list: 0.004, effective: 0.004 });
    expect(run("standard-subscription", { "brain.billing_mode": "subscription" }, 0.004), "STANDARD_SUBSCRIPTION_UNCHANGED").toEqual({ list: 0.004, effective: 0 });
  } finally { db.close(); }
});

test("a fast turn's live usage counts as unpriced, so the token stops hold it instead of a standard price", async () => {
  const db = createUiDb(":memory:");
  try {
    const budgets = createTurnBudgets(db, { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" }) }, () => Date.UTC(2026, 6, 12, 12));
    const policy = resolveGovernancePolicy({ schema_version: 1, budgets: { turn: { warn_usd: 1, block_usd: 2, block_tokens: 10 }, session: { warn_usd: 3, block_usd: 4, block_tokens: 20 }, day: { warn_usd: 3, block_usd: 4, block_tokens: 20 } } });
    const usage = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { "claude-opus-5-5": { inputTokens: n } } });
    await budgets.begin("standard", "ithaca", policy);
    expect(budgets.listPrice("standard", usage(1)), "STANDARD_TURN_PRICED").toBe(1);
    await budgets.begin("fast", "ithaca-fast", policy, undefined, "fast");
    expect(budgets.listPrice("fast", usage(1)), "FAST_TURN_NEVER_STANDARD_PRICED").toBeNull();
    const first = (await budgets.observe("fast", usage(9)))!;
    expect(first.receipt.listPriceCostUsd).toBeNull();
    expect(first.blocked).toBeUndefined();
    expect((await budgets.observe("fast", usage(10)))!.blocked?.scope, "FAST_TURN_TOKEN_STOP").toBe("turn");
  } finally { db.close(); }
});
