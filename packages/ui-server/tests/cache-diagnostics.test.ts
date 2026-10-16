import { expect, test } from "bun:test";
import { StreamAdapter } from "../../ui-backend-claude/src/stream-adapter";
import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";

test("first main cache receipt survives later root and child responses", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test" });
    const recorder = createTurnRecorder({ store }, { turnId: "cache-turn", sessionId: "odyssey" });
    const adapter = new StreamAdapter(event => recorder.observeActivity(event));
    // Title provenance arrives on its own channel, even when it shares the main model.
    recorder.observeActivity({ kind: "claude_title_usage", coverage: "observed", receipts: [{ receiptId: "title",
      source: "generate_session_title", usage: { inputTokens: 100, cacheReadTokens: 900, perModel: { "same-model": { inputTokens: 100 } } },
    }] } as any);
    for (const [id, parent, read, write] of [["child", "agent", 900, 800], ["first", null, 42, 7], ["later", null, 99, 88]] as const) {
      adapter.adapt({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: {
        id, model: "same-model", usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write },
      } } } as any);
      adapter.adapt({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_stop" } } as any);
    }
    recorder.finish("success");
    expect(store.getSpan("cache-turn:turn")?.attrs["brain.cache.first_request"], "FIRST_MAIN_CACHE_RECEIPT")
      .toEqual({ inputTokens: 3, cacheReadTokens: 42, cacheCreationTokens: 7, source: "claude_root_stream", coverage: "provider_reported" });
  } finally { db.close(); }
});

import { promptPrefixFingerprint } from "@schlessera/brain-ui-sdk/internal";
import { cacheDiagnostics } from "../src/activity/cache-diagnostics";
import { computeRuntimeStats } from "../src/activity/stats";
import { createActivityRoutes } from "../src/routes/activity";

const inputs = { tools: [{ name: "read_raft", description: "Inspect the raft", schema: { type: "object" } }],
  system: "Odysseus returns to Ithaca", model: "odyssey-model", thinking: "medium", gitStatusIncluded: false };

for (const component of ["tools", "system", "model", "thinking"] as const) test(`prefix changes only the ${component} digest`, () => {
  const first = promptPrefixFingerprint(inputs);
  const again = promptPrefixFingerprint(inputs);
  expect(again).toEqual(first);
  const next = promptPrefixFingerprint({ ...inputs, [component]: component === "tools" ? [...inputs.tools, { name: "inspect_sail", description: "Read sail", schema: {} }] : "changed" });
  for (const key of ["tools", "system", "model", "thinking"] as const) {
    if (key === component) expect(next[key]).not.toBe(first[key]); else expect(next[key]).toBe(first[key]);
    expect(next[key]).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(JSON.stringify(next)).not.toContain("Odysseus");
  expect(JSON.stringify(next)).not.toContain("raft");
});

test("resumed diagnostics compare adjacent retained turns and expose sums through actual routes", async () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test" });
    const prefix = promptPrefixFingerprint(inputs);
    const record = (id: string, resumed: boolean, model = inputs.model) => {
      const recorder = createTurnRecorder({ store }, { turnId: id, sessionId: "odyssey" });
      recorder.observeActivity({ kind: "prompt_prefix", resumed, prefix: promptPrefixFingerprint({ ...inputs, model }) });
      recorder.observeActivity({ kind: "first_request_cache", usage: { inputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 7, source: "claude_root_stream", coverage: "provider_reported" } });
      // Neither a duplicate nor a same-model auxiliary evidence event can replace the first main request.
      recorder.observeActivity({ kind: "first_request_cache", usage: { inputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 300, source: "claude_root_stream", coverage: "provider_reported" } });
      recorder.observeActivity({ kind: "claude_session_usage", cumulative: { inputTokens: 103, cacheReadTokens: 200 } });
      recorder.finish("success");
      return cacheDiagnostics(store.getSpan(`${id}:turn`)!.attrs);
    };
    expect(record("first", false)?.suspectedBreak).toBe(false);
    expect(record("same", true)).toMatchObject({ suspectedBreak: true, changed: "unchanged", prefix });
    expect(record("changed", true, "other-model")).toMatchObject({ suspectedBreak: true, changed: ["model"] });
    const app = createActivityRoutes({ db, store });
    const detail = await (await app.request("/activity/runs/changed")).json();
    expect(detail.cacheDiagnostics).toMatchObject({ suspectedBreak: true, changed: ["model"], firstRequest: { cacheCreationTokens: 7 } });
    const stats = await (await app.request("/activity/stats")).json();
    expect(stats.window.cacheDiagnostics, "CACHE_STATS_FIRST_ONLY").toMatchObject({ observedRuns: 3, unknownRuns: 0, inputTokens: 9, cacheCreationTokens: 21, suspectedBreaks: 2 });
    store.prune({ now: Date.now() + 100, digestFloorAt: Date.now() + 100, detailRetentionMs: 0, hardCeilingMs: 0 });
    expect(computeRuntimeStats(db, { days: 30 }).window.cacheDiagnostics).toMatchObject({ observedRuns: 0, unknownRuns: 3, unknownBreakRuns: 3 });
    expect(record("after-pruning", true)).toMatchObject({ suspectedBreak: true, changed: "unknown" });
  } finally { db.close(); }
});

test("missing cache evidence stays unknown and arbitrary prompt text cannot be persisted", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test" });
    const recorder = createTurnRecorder({ store }, { turnId: "unknown", sessionId: "odyssey" });
    recorder.observeActivity({ kind: "prompt_prefix", resumed: true, prefix: { ...promptPrefixFingerprint(inputs), system: "secret prompt" } });
    recorder.observeActivity({ kind: "first_request_cache", usage: { inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, source: "claude_root_stream", coverage: "provider_reported" } });
    recorder.finish("success");
    expect(cacheDiagnostics(store.getSpan("unknown:turn")!.attrs)).toMatchObject({ prefix: null, suspectedBreak: null, changed: "unknown" });
    expect(JSON.stringify(store.snapshotRun("unknown"))).not.toContain("secret prompt");
  } finally { db.close(); }
});

test("a newly identified first session remains the next turn's baseline", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test" });
    const prefix = promptPrefixFingerprint(inputs);
    const first = createTurnRecorder({ store }, { turnId: "new-identity", sessionId: null });
    first.observeActivity({ kind: "prompt_prefix", prefix, resumed: false });
    first.observeFrame({ type: "session_info", sessionId: "odyssey", isNew: true });
    first.finish("success");
    const next = createTurnRecorder({ store }, { turnId: "resume-identity", sessionId: "odyssey" });
    next.observeActivity({ kind: "prompt_prefix", prefix, resumed: true });
    next.finish("success");
    expect(cacheDiagnostics(store.getSpan("resume-identity:turn")!.attrs)?.changed, "NEW_SESSION_PREFIX_BASELINE").toBe("unchanged");
  } finally { db.close(); }
});
