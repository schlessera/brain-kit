import { expect, test } from "bun:test";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/protocol";
import { reconcileClaudeUsage } from "../src/ws/claude-usage-accounting.js";
const usage = (n: number) => sumModelUsage({ "claude-sonnet-4-6": { inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheCreationTokens: n } });
test("unstreamed same-model spend is retained once independently of main receipts", () => {
  const first = reconcileClaudeUsage(undefined, usage(10), usage(11), false);
  expect(first.auxiliary, "AUXILIARY_SPEND_RETAINED").toEqual(usage(1));
  const resumed = reconcileClaudeUsage(first.state, usage(20), usage(31), true);
  expect(resumed.auxiliary, "RESUMED_AUXILIARY_NOT_RECHARGED").toBeUndefined();
  expect(resumed.state.completed).toEqual(usage(30).perModel!);
  const later = reconcileClaudeUsage(resumed.state, usage(5), usage(38), true);
  expect(later.auxiliary).toEqual(usage(2));
});
test("cancelled-response receipts and decreasing runtime totals never become negative spend", () => {
  const first = reconcileClaudeUsage(undefined, usage(10), usage(11), false);
  const cancelled = reconcileClaudeUsage(first.state, usage(5), undefined, true);
  const next = reconcileClaudeUsage(cancelled.state, usage(3), usage(12), true);
  expect(next.state.completed).toEqual(usage(18).perModel!);
  expect(next.state.partial).toBe(true);
  expect(next.auxiliary).toBeUndefined();
  const recovered = reconcileClaudeUsage(next.state, usage(1), usage(20), true);
  expect(recovered.auxiliary).toBeUndefined();
});
test("imported history is an unknown opening baseline rather than new auxiliary spend", () => {
  const imported = reconcileClaudeUsage(undefined, usage(10), usage(100), true);
  expect(imported.auxiliary).toBeUndefined();
  expect(imported.state.partial).toBe(true);
  const next = reconcileClaudeUsage(imported.state, usage(5), usage(106), true);
  expect(next.auxiliary).toEqual(usage(1));
});

import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";

test("persisted session and Activity sum own turns and once-only unstreamed spend across restart", () => {
  const db = createUiDb(":memory:");
  try {
    const pricing = { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const }) };
    const store = createActivityStore(db, { pricing });
    let catalog = createSessionCatalog(() => db, undefined, undefined, { pricing, store });
    catalog.persistSessionStub("odysseus-session", "Review the voyage", null, "claude");
    for (const [turn, own, cumulative] of [[1, 10, 11], [2, 20, 31], [3, 5, 36]] as const) {
      const costUsd = catalog.accountClaudeUsage!("odysseus-session", "claude", `turn-${turn}`,
        { completed: usage(own), cumulative: usage(cumulative) }, turn > 1, { billingMode: "api" });
      expect(costUsd, "TURN_COST_USES_OWN_RECEIPTS").toBe(own * 4);
      catalog.persistSession({ type: "result", sessionId: "odysseus-session", outcome: "success", isError: false,
        durationMs: 1, numTurns: 1, usage: usage(own), costUsd }, "Review the voyage", null, "claude");
      // A fresh catalog instance must not forget the auxiliary high-water.
      catalog = createSessionCatalog(() => db, undefined, undefined, { pricing, store });
    }
    expect(db.query("SELECT total_cost_usd FROM sessions WHERE id=?").get("odysseus-session"), "SESSION_SUM_IS_NOT_SUM_OF_CUMULATIVE_COSTS")
      .toEqual({ total_cost_usd: 144 });
    const auxiliary = db.query("SELECT cost_usd,input_tokens,output_tokens FROM activity_run_rollups WHERE run_id LIKE ?").all("%:claude-unstreamed");
    expect(auxiliary, "AUXILIARY_OVERALL_ONCE").toEqual([{ cost_usd: 4, input_tokens: 1, output_tokens: 1 }]);
    // A retried terminal cannot book the auxiliary observation a second time.
    catalog.accountClaudeUsage!("odysseus-session", "claude", "turn-1", { completed: usage(10), cumulative: usage(11) }, false);
    expect(db.query("SELECT total_cost_usd FROM sessions WHERE id=?").get("odysseus-session")).toEqual({ total_cost_usd: 144 });
  } finally { db.close(); }
});

import { StreamAdapter } from "../../ui-backend-claude/src/stream-adapter.js";
import { usageEvents } from "../../ui-backend-claude/tests/helpers/usage-events.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createActivityStream } from "../src/activity/stream.js";
import { WsHost } from "../src/ws/host.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";

test("real turn dispatch records resumed root/child usage, prices main runs and retains auxiliary once", async () => {
  const db = createUiDb(":memory:");
  const pricing = { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const }) };
  const store = createActivityStore(db, { pricing }), stream = createActivityStream(store);
  const catalog = createSessionCatalog(() => db, undefined, undefined, { pricing, store });
  let turn = 0;
  const backend = makeFakeBackend({ id: "claude", startTurn: async req => {
    turn++;
    const sessionId = "odysseus-accounting";
    req.bridge.emit({ type: "session_info", sessionId, isNew: turn === 1, providerId: "claude" });
    const adapter = new StreamAdapter(event => req.bridge.activity?.(event));
    for (const msg of [
      ...usageEvents(sessionId, "claude-sonnet-4-6", turn * 6, turn * 6, turn * 6, turn * 6),
      ...usageEvents(sessionId, "claude-sonnet-4-6", turn * 4, turn * 4, turn * 4, turn * 4)
        .map(message => ({ ...message, parent_tool_use_id: "loom" }) as SDKMessage),
      { type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: turn === 1 ? 44 : 124,
        duration_ms: 1, num_turns: 1, modelUsage: { "claude-sonnet-4-6": {
          inputTokens: turn === 1 ? 11 : 31, outputTokens: turn === 1 ? 11 : 31,
          cacheReadInputTokens: turn === 1 ? 11 : 31, cacheCreationInputTokens: turn === 1 ? 11 : 31,
        } } } as unknown as SDKMessage,
    ]) for (const frame of adapter.adapt(msg)) req.bridge.emit(frame);
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "claude"), catalog, activity: { store, stream } });
  const frames: ServerMessage[] = [], ws = { send: (data: string) => frames.push(JSON.parse(data)) };
  host.clients.add(ws, "test-principal");
  try {
    for (let n = 1; n <= 2; n++) {
      await handleClientMessage(host, ws, { type: "chat_message", text: "Review the voyage", ...(n > 1 ? { sessionId: "odysseus-accounting" } : {}) },
        { principal: testPrincipal(), authorization: testAuthorization() });
      const deadline = Date.now() + 2000;
      while (frames.filter(frame => frame.type === "result").length < n || host.coordinator.isTurnActive()) {
        if (Date.now() > deadline) throw new Error("turn dispatch did not finish");
        await Bun.sleep(5);
      }
    }
    const main = db.query("SELECT cost_usd,input_tokens,output_tokens FROM activity_run_rollups WHERE run_id NOT LIKE ? ORDER BY cost_usd").all("%:claude-unstreamed");
    expect(main, "ACTIVITY_MAIN_OWN_USAGE").toEqual([
      { cost_usd: 40, input_tokens: 10, output_tokens: 10 }, { cost_usd: 80, input_tokens: 20, output_tokens: 20 },
    ]);
    const results = frames.filter(frame => frame.type === "result");
    expect(results, "HOST_RESULT_OWN_COST_AND_TOKENS").toMatchObject([
      { costUsd: 40, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheCreationTokens: 10 } },
      { costUsd: 80, usage: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 20, cacheCreationTokens: 20 } },
    ]);
    expect(db.query("SELECT SUM(cost_usd) AS cost FROM activity_run_rollups").get(), "OVERALL_MEASURED_SPEND_ONCE").toEqual({ cost: 124 });
    expect(db.query("SELECT total_cost_usd FROM sessions WHERE id=?").get("odysseus-accounting")).toEqual({ total_cost_usd: 124 });
  } finally { host.close(); stream.close(); db.close(); }
});


test("an imported session waits for its first terminal baseline after a cancellation", () => {
  const cancelled = reconcileClaudeUsage(undefined, usage(10), undefined, true);
  const baseline = reconcileClaudeUsage(cancelled.state, usage(5), usage(100), true);
  expect(baseline.auxiliary).toBeUndefined();
  const next = reconcileClaudeUsage(baseline.state, usage(5), usage(105), true);
  expect(next.auxiliary).toBeUndefined();
  expect(next.state.partial).toBe(true);
});


test("an intermediate total retains measured auxiliary usage when a continuation is cancelled", () => {
  const cancelled = reconcileClaudeUsage(undefined, usage(30), usage(11), false, usage(10));
  expect(cancelled.auxiliary).toEqual(usage(1));
  expect(cancelled.state.completed).toEqual(usage(30).perModel!);
  expect(cancelled.state.partial).toBe(true);
  const resumed = reconcileClaudeUsage(cancelled.state, usage(5), usage(36), true);
  expect(resumed.auxiliary).toBeUndefined();
});
