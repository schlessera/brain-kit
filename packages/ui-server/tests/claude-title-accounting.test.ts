import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendActivityEvent, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/protocol";
import { StreamAdapter } from "../../ui-backend-claude/src/stream-adapter.js";
import { usageEvents } from "../../ui-backend-claude/tests/helpers/usage-events.js";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { allocateClaudeTitleUsage, reconcileClaudeUsage } from "../src/ws/claude-usage-accounting.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { WsHost } from "../src/ws/host.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";

const model = "claude-sonnet-4-6";
const usage = (n: number) => sumModelUsage({ [model]: { inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheCreationTokens: n } });
const helper = { receiptId: "request:odysseus-title", source: "generate_session_title" as const, usage: usage(1), costUsd: 4 };

test("real dispatch separates same-model title/main/child and retains unmatched spend once across resumes", async () => {
  const db = createUiDb(":memory:");
  const pricing = { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const }) };
  const store = createActivityStore(db, { pricing }), stream = createActivityStream(store);
  const catalog = createSessionCatalog(() => db, undefined, undefined, { pricing, store });
  let turn = 0;
  const backend = makeFakeBackend({ id: "claude", startTurn: async req => {
    const n = ++turn, own = n === 1 ? 10 : n === 2 ? 20 : 5, cumulative = n === 1 ? 13 : n === 2 ? 33 : 40;
    const sessionId = "odysseus-title-accounting";
    req.bridge.emit({ type: "session_info", sessionId, isNew: n === 1, providerId: "claude" });
    const adapter = new StreamAdapter(event => req.bridge.activity?.(event));
    for (const message of [
      ...usageEvents(sessionId, model, own * 0.6, own * 0.6, own * 0.6, own * 0.6),
      ...usageEvents(sessionId, model, own * 0.4, own * 0.4, own * 0.4, own * 0.4)
        .map(message => ({ ...message, parent_tool_use_id: "odysseus-child" }) as SDKMessage),
    ]) for (const frame of adapter.adapt(message)) req.bridge.emit(frame);
    const terminal = adapter.adapt({ type: "result", subtype: "success", is_error: false, session_id: sessionId,
      total_cost_usd: cumulative * 4, duration_ms: 1, num_turns: 1, modelUsage: { [model]: {
        inputTokens: cumulative, outputTokens: cumulative, cacheReadInputTokens: cumulative, cacheCreationInputTokens: cumulative,
      } } } as unknown as SDKMessage);
    // Production SDK options publish exporter receipts after worker exit and
    // before releasing the held terminal. Duplicate exports and stale replays
    // must not turn into another charge, even beside later auxiliary usage.
    req.bridge.activity?.({ kind: "claude_title_usage", coverage: "observed", receipts: n === 1 ? [helper, helper] : [helper] });
    for (const frame of terminal) req.bridge.emit(frame);
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "claude"), catalog, activity: { store, stream } });
  const frames: ServerMessage[] = [], ws = { send: (data: string) => frames.push(JSON.parse(data)) };
  host.clients.add(ws, "test-principal");
  try {
    for (let n = 1; n <= 3; n++) {
      await handleClientMessage(host, ws, { type: "chat_message", text: "Review Odysseus's voyage", ...(n > 1 ? { sessionId: "odysseus-title-accounting" } : {}) },
        { principal: testPrincipal(), authorization: testAuthorization() });
      const deadline = Date.now() + 2000;
      while (frames.filter(frame => frame.type === "result").length < n || host.coordinator.isTurnActive()) {
        if (Date.now() > deadline) throw new Error("Title-accounting turn dispatch did not finish");
        await Bun.sleep(5);
      }
    }
    const main = db.query("SELECT cost_usd,input_tokens,cache_read_tokens FROM activity_run_rollups WHERE run_id NOT LIKE ? AND run_id NOT LIKE ? ORDER BY cost_usd")
      .all("%:claude-unstreamed", "%:claude-title:%");
    expect(main, "TITLE_HELPER_EXCLUDED_FROM_MAIN_AND_CACHE").toEqual([
      { cost_usd: 20, input_tokens: 5, cache_read_tokens: 5 }, { cost_usd: 40, input_tokens: 10, cache_read_tokens: 10 },
      { cost_usd: 80, input_tokens: 20, cache_read_tokens: 20 },
    ]);
    const firstCache = (db.query("SELECT attrs FROM activity_spans WHERE parent_span_id IS NULL").all() as { attrs: string }[])
      .map(row => JSON.parse(row.attrs)["brain.cache.first_request"]).filter(Boolean).sort((a, b) => a.inputTokens - b.inputTokens);
    expect(firstCache, "TITLE_HELPER_CANNOT_REPLACE_FIRST_ROOT_CACHE_RECEIPT").toEqual([3, 6, 12].map(tokens => ({
      inputTokens: tokens, cacheReadTokens: tokens, cacheCreationTokens: tokens,
      source: "claude_root_stream", coverage: "provider_reported",
    })));
    expect(db.query("SELECT cost_usd,input_tokens FROM activity_run_rollups WHERE run_id LIKE ?").all("%:claude-title:%"), "TITLE_ACTIVITY_MEASURED_ONCE")
      .toEqual([{ cost_usd: 4, input_tokens: 1 }]);
    expect(db.query("SELECT cost_usd,input_tokens FROM activity_run_rollups WHERE run_id LIKE ? ORDER BY run_id").all("%:claude-unstreamed"), "UNMATCHED_AUXILIARY_RETAINED")
      .toEqual([{ cost_usd: 8, input_tokens: 2 }, { cost_usd: 8, input_tokens: 2 }]);
    expect(db.query("SELECT SUM(cost_usd) AS cost FROM activity_run_rollups").get(), "OVERALL_TITLE_SPEND_EXACTLY_ONCE").toEqual({ cost: 160 });
    expect(db.query("SELECT total_cost_usd FROM sessions WHERE id=?").get("odysseus-title-accounting"), "SESSION_TITLE_SPEND_EXACTLY_ONCE")
      .toEqual({ total_cost_usd: 160 });
    expect(frames.filter(frame => frame.type === "result"), "ROOT_RESULTS_KEEP_ONLY_OWN_MAIN_AND_CHILD").toMatchObject([
      { costUsd: 40, usage: { inputTokens: 10 } }, { costUsd: 80, usage: { inputTokens: 20 } }, { costUsd: 20, usage: { inputTokens: 5 } },
    ]);
  } finally { host.close(); stream.close(); db.close(); }
});

test("allocation remains conservative for replay, unknown, missing totals and imported baselines", () => {
  const evidence: Omit<Extract<BackendActivityEvent, { kind: "claude_title_usage" }>, "kind"> = { coverage: "observed", receipts: [helper] };
  const first = allocateClaudeTitleUsage(usage(3), evidence);
  expect(first.title).toEqual([helper]);
  expect(first.unattributed).toEqual(usage(2));
  const restarted = allocateClaudeTitleUsage(usage(2), evidence, JSON.parse(JSON.stringify(first.seenIds)));
  expect(restarted.title, "REPLAYED_HELPER_NOT_ALLOCATED_AGAIN").toHaveLength(0);
  expect(restarted.unattributed).toEqual(usage(2));
  expect(allocateClaudeTitleUsage(usage(3), undefined).unattributed, "NO_PROVENANCE_STAYS_UNATTRIBUTED").toEqual(usage(3));
  const imported = reconcileClaudeUsage(undefined, usage(10), usage(100), true);
  const unavailable = allocateClaudeTitleUsage(imported.auxiliary, evidence);
  expect(unavailable.title, "NO_MATCHING_DELTA_CANNOT_INVENT_ALLOCATION").toHaveLength(0);
  expect(unavailable.partial).toBe(true);
});


test("unjoinable measured title receipts retain partial raw evidence without inventing a free helper", () => {
  const db = createUiDb(":memory:");
  try {
    const pricing = { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const }) };
    const store = createActivityStore(db, { pricing });
    const catalog = createSessionCatalog(() => db, undefined, undefined, { pricing, store });
    catalog.persistSessionStub("odysseus-unjoinable", "Review the voyage", null, "claude");
    catalog.accountClaudeUsage!("odysseus-unjoinable", "claude", "odysseus-unjoinable-turn", {
      completed: usage(10), title: { coverage: "observed", receipts: [helper] },
    }, false, { billingMode: "api" });
    expect(db.query("SELECT cost_usd FROM activity_run_rollups WHERE run_id LIKE ?").all("%:claude-unstreamed"), "UNJOINABLE_COVERAGE_UNPRICED_NOT_ZERO")
      .toEqual([{ cost_usd: null }]);
    expect(db.query("SELECT COUNT(*) AS count FROM activity_run_rollups WHERE run_id LIKE ?").get("%:claude-title:%"), "NO_FABRICATED_TITLE_ALLOCATION")
      .toEqual({ count: 0 });
    const span = db.query("SELECT attrs FROM activity_spans WHERE run_id LIKE ?").get("%:claude-unstreamed") as { attrs: string };
    const attrs = JSON.parse(span.attrs);
    expect(attrs["brain.usage.coverage"]).toBe("partial");
    expect(JSON.parse(attrs["brain.usage.title_evidence"]).receipts[0].costUsd, "MEASURED_UNJOINABLE_COST_EVIDENCE_RETAINED").toBe(4);
  } finally { db.close(); }
});
