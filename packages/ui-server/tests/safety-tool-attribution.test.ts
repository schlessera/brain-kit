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
