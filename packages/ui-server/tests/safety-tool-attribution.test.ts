/** The host decides attribution (#4513): differently named calls under one
 * tool-use ID in a turn, from any hook, result or loss report the collector
 * observes, nested calls included, make that ID's inputs unattributable.
 * The fact is durable and reaches only readers that opt in. Keyless. */
import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client";
import { SafetyHistory } from "../src/governance/safety-history";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { createPermissionWiring } from "../../ui-backend-claude/src/permission-hooks";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
const harbour = { url: "https://ithaca.example/harbour" };
function collect(f: Fixture, signal = new AbortController().signal) {
  return createSafetyCollector(f.db, f.writes, { turnId: "voyage", bindingId: f.bindingId, backendId: "claude",
    sessionId: () => "ithaca", shellProxied: () => true, signal });
}
async function attributions(history: SafetyHistory, f: Fixture, optIn = true) {
  const page = await history.read(f.principal, { sessionId: "ithaca" }, null, 50, true, true, true, optIn);
  return page.records.filter(record => record.kind === "attribution");
}

test("differently named calls under one ID make its attribution unknown, durably, for opted-in readers only", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    collector.admitting?.("fetch", "Bash");
    await f.writes.safetyEnd("voyage");
    expect((await attributions(f.history, f)).map(record => record.kind === "attribution" && record.toolUseId), "REUSED_ID_ATTRIBUTION_UNKNOWN").toEqual(["fetch"]);
    expect(await attributions(f.history, f, false), "LEGACY_READERS_KEEP_THEIR_SHAPE").toEqual([]);
    const http = await (await f.get("?entries=1&attribution=1")).json();
    expect(http.records.filter((record: { kind: string }) => record.kind === "attribution")).toHaveLength(1);
    const restarted = createUiDb(f.path);
    try {
      expect((await attributions(new SafetyHistory(restarted, () => true, async () => {}), f)).length, "ATTRIBUTION_SURVIVES_RESTART").toBe(1);
    } finally { restarted.close(); }
  } finally { await f.close(); }
});

test("a nested call reusing a top-level call's ID makes its attribution unknown", async () => {
  const f = await safetyHistoryFixture();
  try {
    const controller = new AbortController();
    const collector = collect(f, controller.signal);
    const { hooks } = createPermissionWiring({
      req: { prompt: "Read the harbour report", signal: controller.signal, bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" }), inputSafety: collector } },
      allowedTools: ["WebFetch", "Read"], confirmPatterns: [], brainPath: f.root,
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never,
      childEnv: {}, log() {},
    });
    const pre = (tool: string) => hooks!.PreToolUse!.filter(group => !group.matcher || new RegExp(`^(?:${group.matcher})$`).test(tool)).flatMap(group => group.hooks);
    const run = (tool: string, input: Record<string, unknown>, nested: boolean) => Promise.all(pre(tool).map(hook => hook({ hook_event_name: "PreToolUse",
      tool_name: tool, tool_use_id: "fetch", tool_input: input, cwd: f.root, session_id: "ithaca", transcript_path: "",
      ...(nested ? { agent_id: "scout", agent_type: "general-purpose" } : {}) } as never, "fetch", { signal: controller.signal })));
    await run("WebFetch", harbour, false);
    await run("Read", { file_path: "notes/loom.md" }, true);
    await f.writes.safetyEnd("voyage");
    expect((await attributions(f.history, f)).length, "NESTED_REUSE_IS_OBSERVED").toBe(1);
  } finally { await f.close(); }
});

test("one tool name under an ID, however often observed, keeps its attribution", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    collector.admitting?.("fetch", "WebFetch");
    await collector.result("fetch", "WebFetch", "Harbour notes", true);
    await f.writes.safetyEnd("voyage");
    expect(await attributions(f.history, f), "UNIQUE_NAME_STAYS_ATTRIBUTED").toEqual([]);
  } finally { await f.close(); }
});

test("a transient attribution write failure gaps nothing, is served from memory, and commits on retry", async () => {
  const f = await safetyHistoryFixture();
  try {
    let failing = true, attempts = 0;
    const writes = { ...f.writes, safetyToolReuse: async (...args: Parameters<Fixture["writes"]["safetyToolReuse"]>) => {
      attempts++;
      if (failing) throw new Error("The ledger is busy with the suitors");
      return f.writes.safetyToolReuse(...args);
    } };
    const collector = createSafetyCollector(f.db, writes, { turnId: "voyage", bindingId: f.bindingId, backendId: "claude",
      sessionId: () => "ithaca", shellProxied: () => true, signal: new AbortController().signal });
    collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    await collector.allowed?.("fetch");
    await collector.result("fetch", "WebFetch", "Harbour notes", true);
    collector.admitting?.("fetch", "Bash");
    for (let i = 0; i < 200 && !attempts; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const served = await attributions(f.history, f);
    expect(served.map(record => record.id.startsWith("pending_")), "MEMORY_SERVES_THE_UNSETTLED_FACT").toEqual([true]);
    expect(f.writes.safety(null, "ithaca").reasons, "DISPLAY_FAILURE_GAPS_NOTHING").not.toContain("recording_failed");
    failing = false;
    collector.admitting?.("raft", "Read");
    await f.writes.safetyEnd("voyage");
    expect(f.writes.safety(null, "ithaca").reasons, "DISPLAY_FAILURE_GAPS_NOTHING").not.toContain("recording_failed");
    const restarted = createUiDb(f.path);
    try {
      const durable = await attributions(new SafetyHistory(restarted, () => true, async () => {}), f);
      expect(durable.map(record => record.kind === "attribution" && record.toolUseId), "RETRY_COMMITS_THE_FACT").toEqual(["fetch"]);
    } finally { restarted.close(); }
  } finally { await f.close(); }
});

test("past the collector's tracking room, every ID in the turn reads as unknown", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    for (let i = 0; i < 2000; i++) collector.admitting?.(`oar_${i}`, "Grep");
    await collector.begin("fetch", "WebFetch", harbour);
    await f.writes.safetyEnd("voyage");
    expect((await attributions(f.history, f)).map(record => record.kind === "attribution" && record.toolUseId), "OVERFLOW_IS_TURN_WIDE").toEqual([null]);
  } finally { await f.close(); }
});

test("past the store's per-turn count, one turn-wide fact covers every ID", async () => {
  const f = await safetyHistoryFixture();
  try {
    for (let i = 0; i < 2049; i++) await f.writes.safetyToolReuse("voyage", `oar_${i}`);
    const rows = f.db.query("SELECT tool_use_id FROM safety_tool_reuse ORDER BY length(sequence),sequence").all() as { tool_use_id: string | null }[];
    expect(rows).toHaveLength(2049);
    expect(rows.at(-1)!.tool_use_id, "STORE_OVERFLOW_IS_TURN_WIDE").toBeNull();
    await f.writes.safetyToolReuse("voyage", "oar_late");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_tool_reuse").get(), "TURN_WIDE_COVERS_LATER_IDS").toEqual({ n: 2049 });
  } finally { await f.close(); }
});

test("reuse facts are charged against the history ceilings and refused at them", async () => {
  const f = await safetyHistoryFixture();
  try {
    const before = f.db.query("SELECT used_rows,used_bytes FROM safety_meta").get() as { used_rows: number; used_bytes: number };
    await f.writes.safetyToolReuse("voyage", "fetch");
    const after = f.db.query("SELECT used_rows,used_bytes FROM safety_meta").get() as { used_rows: number; used_bytes: number };
    expect({ rows: after.used_rows - before.used_rows, bytes: after.used_bytes - before.used_bytes }, "REUSE_ROW_IS_CHARGED").toEqual({ rows: 1, bytes: 512 });
    expect(f.db.query("SELECT COALESCE(SUM(reserved_rows),0) n FROM safety_usage").get(), "USAGE_VIEW_COUNTS_IT").toEqual({ n: 1 + (f.db.query("SELECT COALESCE(SUM(reserved_rows),0) n FROM safety_records").get() as { n: number }).n });
    f.db.run("UPDATE safety_meta SET used_rows=1000000");
    let refused: unknown;
    try { await f.writes.safetyToolReuse("voyage", "raft"); } catch (error) { refused = error; }
    expect(String(refused), "CEILING_REFUSES_THE_FACT").toContain("capacity");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_tool_reuse").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("a fallback tool name is no name", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    collector.admitting?.("fetch");
    await collector.lost?.("fetch", "unknown", new Error("The Pi report lost its tool name"));
    await f.writes.safetyEnd("voyage");
    expect(await attributions(f.history, f), "FALLBACK_NAME_IS_NO_SECOND_NAME").toEqual([]);
  } finally { await f.close(); }
});
