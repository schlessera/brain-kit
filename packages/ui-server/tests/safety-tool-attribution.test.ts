/** The host decides attribution (#4513). Its collector notes every tool name
 * it observes under each tool-use ID of a turn, in memory, and the
 * collection's own end stores the reused IDs. Opted-in readers receive them
 * in the projection; a turn never checked reads as before. Display-only:
 * nothing here changes a revision, a count or enforcement. Keyless. */
import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client";
import { SafetyHistory } from "../src/governance/safety-history";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { recoverSafetyCollections, safetyCatalogCreated } from "../src/governance/safety-store";
import { safetyQueue } from "../src/governance/safety-queue";
import { retireChat } from "../src/ws/chat-lifecycle";
import { createPermissionWiring } from "../../ui-backend-claude/src/permission-hooks";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";
import { until } from "../../../tests/helpers/until";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
const harbour = { url: "https://ithaca.example/harbour" };
function collect(f: Fixture, turnId = "voyage") {
  return createSafetyCollector(f.db, f.writes, { turnId, bindingId: f.bindingId, backendId: "claude",
    sessionId: () => "ithaca", shellProxied: () => true, signal: new AbortController().signal });
}
async function page(history: SafetyHistory, f: Fixture, optIn = true, limit = 50) {
  return history.read(f.principal, { sessionId: "ithaca" }, null, limit, true, true, true, optIn);
}
/** Every page of one snapshot, following its real continuation cursors. */
async function pages(history: SafetyHistory, f: Fixture, limit: number) {
  const all = [await history.read(f.principal, { sessionId: "ithaca" }, null, limit, true, true, true, true)];
  while (all.at(-1)!.nextCursor) all.push(await history.read(f.principal, { sessionId: "ithaca" }, all.at(-1)!.nextCursor, limit, true, true, true, true));
  return all;
}
/** The subscription poll in flight has settled. */
const settled = (history: SafetyHistory) => until(() => [...(history as unknown as { subscriptions: Map<object, { busy: boolean }> }).subscriptions.values()].every(s => !s.busy), "the subscription poll");
async function flags(history: SafetyHistory, f: Fixture) {
  return (await page(history, f)).projection.attributionUnknown;
}
async function reused(f: Fixture, collector = collect(f)) {
  collector.admitting?.("fetch", "WebFetch");
  await collector.begin("fetch", "WebFetch", harbour);
  await collector.allowed?.("fetch");
  await collector.result("fetch", "WebFetch", "Harbour notes", true);
  collector.admitting?.("fetch", "Bash");
  return collector;
}
const restarted = async <T>(f: Fixture, read: (history: SafetyHistory) => Promise<T>) => {
  const db = createUiDb(f.path);
  try { return await read(new SafetyHistory(db, () => true, async () => {})); } finally { db.close(); }
};

test("T1 reuse is reported live, after the end and after a reopen, on every page, to opted-in readers only", async () => {
  const f = await safetyHistoryFixture();
  try {
    await f.add("connection", true); await f.add("loom");
    await reused(f);
    const expected = [{ bindingId: f.bindingId, toolUseIds: ["fetch"] }];
    expect(await flags(f.history, f), "LIVE_REUSE_IS_REPORTED").toEqual(expected);
    await f.writes.safetyEnd("voyage");
    expect(await flags(f.history, f), "ENDED_REUSE_IS_REPORTED").toEqual(expected);
    expect(await restarted(f, history => flags(history, f)), "REOPENED_REUSE_IS_REPORTED").toEqual(expected);
    const paged = await pages(f.history, f, 1);
    expect(paged.length, "THE_SNAPSHOT_SPANS_PAGES").toBeGreaterThan(2);
    expect(paged.map(read => read.projection.attributionUnknown), "EVERY_PAGE_CARRIES_IT").toEqual(paged.map(() => expected));
    expect("attributionUnknown" in (await page(f.history, f, false)).projection, "LEGACY_READERS_KEEP_THEIR_SHAPE").toBe(false);
  } finally { await f.close(); }
});

test("T2 one name, however often observed, keeps its attribution", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    for (let i = 0; i < 3; i++) collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    await f.writes.safetyEnd("voyage");
    expect(await flags(f.history, f), "UNIQUE_NAME_STAYS_ATTRIBUTED").toEqual([]);
  } finally { await f.close(); }
});

test("T3 a turn that crashed before its end reads as before, with or without observed reuse", async () => {
  for (const sawReuse of [true, false]) {
    const f = await safetyHistoryFixture();
    try {
      const collector = collect(f);
      if (sawReuse) { collector.admitting?.("fetch", "WebFetch"); collector.admitting?.("fetch", "Bash"); }
      const db = createUiDb(f.path);
      try {
        recoverSafetyCollections(db);
        expect(db.query("SELECT tool_reuse FROM safety_collections").all(), "RESTART_LEAVES_THE_TURN_UNCHECKED").toEqual([{ tool_reuse: null }]);
        expect(await flags(new SafetyHistory(db, () => true, async () => {}), f), "NEVER_CHECKED_READS_AS_BEFORE").toEqual([]);
      } finally { db.close(); }
    } finally { await f.close(); }
  }
});

test("T4 a database from before the column, upgraded, reads as before", async () => {
  const f = await safetyHistoryFixture();
  try {
    await f.writes.safetyEnd("voyage");
    f.db.exec("ALTER TABLE safety_collections DROP COLUMN tool_reuse");
    f.db.query("DELETE FROM _migrations WHERE filename='104_safety_tool_reuse.sql'").run();
    expect(await restarted(f, async history => {
      expect((history as unknown as { db: { query(sql: string): { all(): unknown } } }).db.query("SELECT tool_reuse FROM safety_collections").all()).toEqual([{ tool_reuse: null }]);
      return flags(history, f);
    }), "UPGRADED_TURN_READS_AS_BEFORE").toEqual([]);
  } finally { await f.close(); }
});

test("T5 a refused end keeps serving the live finding; a reopen reads as before", async () => {
  const f = await safetyHistoryFixture();
  try {
    await reused(f);
    f.db.run("CREATE TRIGGER sirens_hold_the_end BEFORE UPDATE OF ended ON safety_collections BEGIN SELECT RAISE(ABORT,'disk I/O error'); END");
    let refused = false;
    try { await f.writes.safetyEnd("voyage"); } catch { refused = true; }
    expect(refused).toBe(true);
    expect(await flags(f.history, f), "REFUSED_END_KEEPS_THE_LIVE_FINDING").toEqual([{ bindingId: f.bindingId, toolUseIds: ["fetch"] }]);
    f.db.run("DROP TRIGGER sirens_hold_the_end");
    expect(await restarted(f, history => flags(history, f)), "REOPEN_READS_AS_BEFORE").toEqual([]);
  } finally { await f.close(); }
});

test("T6 observing reuse changes no revision, usage or enforcement projection", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    const meta = () => f.db.query("SELECT revision,used_rows,used_bytes,scope_rows,scope_bytes FROM safety_meta").get();
    const before = { meta: meta(), enforcement: f.writes.safety(null, "ithaca") };
    collector.admitting?.("fetch", "Bash");
    expect({ meta: meta(), enforcement: f.writes.safety(null, "ithaca") }, "REUSE_IS_DISPLAY_ONLY").toEqual(before);
  } finally { await f.close(); }
});

test("T7 observation never touches the database", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    const query = f.db.query;
    f.db.query = (() => { throw new Error("The loom is unravelled"); }) as typeof query;
    try {
      expect(() => { collector.admitting?.("fetch", "WebFetch"); collector.admitting?.("fetch", "Bash"); }, "OBSERVATION_HAS_NO_DATABASE_PATH").not.toThrow();
    } finally { f.db.query = query; }
    expect(await flags(f.history, f)).toEqual([{ bindingId: f.bindingId, toolUseIds: ["fetch"] }]);
  } finally { await f.close(); }
});

test("T8 reuse at an equal revision reaches every subscriber as an update, never a gap or a new snapshot", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    const reads = [await page(f.history, f), await page(f.history, f), await page(f.history, f)];
    collector.admitting?.("fetch", "Bash");
    const snapshots = () => (f.history as unknown as { snapshots: Map<string, unknown> }).snapshots.size, before = snapshots();
    const sent: { reason?: string; projection?: { attributionUnknown?: unknown } }[][] = reads.map(() => []);
    reads.forEach((read, i) => f.history.subscribe({}, f.principal, read.identity, read.highWater, read.snapshotId, () => true, value => sent[i]!.push(value as never)));
    await until(() => sent.every(list => list.length > 0), () => sent);
    expect(sent.map(list => list.map(value => value.reason ?? value.projection?.attributionUnknown)), "ATTRIBUTION_CHANGE_IS_AN_UPDATE")
      .toEqual(reads.map(() => [[{ bindingId: f.bindingId, toolUseIds: ["fetch"] }]]));
    expect(snapshots(), "NO_SNAPSHOT_IS_ALLOCATED").toBe(before);
  } finally { await f.close(); }
});

test("T9 reuse followed by another record arrives in the update's projection", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    const read = await page(f.history, f);
    const sent: { projection?: { attributionUnknown?: unknown } }[] = [];
    f.history.subscribe({}, f.principal, read.identity, read.highWater, read.snapshotId, () => true, value => sent.push(value as never));
    // Let the subscription's first poll settle at the snapshot's revision.
    await settled(f.history);
    expect(sent).toEqual([]);
    const recorded = f.add("calypso");
    collector.admitting?.("fetch", "Bash");
    await recorded;
    f.history.poll();
    await until(() => sent.length > 0, () => sent);
    expect(sent.at(-1)?.projection?.attributionUnknown, "UPDATE_CARRIES_THE_FINDING").toEqual([{ bindingId: f.bindingId, toolUseIds: ["fetch"] }]);
  } finally { await f.close(); }
});

/** A second chat of the same owner, with a stored collection of its own. */
async function secondChat(f: Fixture) {
  const bindingId = crypto.randomUUID();
  await f.writes.safetyBegin({ turnId: "aeaea", bindingId, sessionId: null, principalId: f.principal.id, backendId: "claude", at: 0 });
  await f.writes.safetyReady("aeaea", "claude", 1);
  f.db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('aeaea-chat',0,0,'claude')").run();
  f.db.query("INSERT INTO chat_session_owners(session_id,principal_id,created_at) VALUES('aeaea-chat',?,0)").run(f.principal.id);
  safetyCatalogCreated(f.db, "aeaea-chat", f.principal.id, "aeaea");
  await f.writes.bind("aeaea", "aeaea-chat");
  return bindingId;
}

test("T10 another chat's reuse, live or stored, never reaches this chat", async () => {
  const f = await safetyHistoryFixture();
  try {
    const other = await secondChat(f);
    const read = await page(f.history, f);
    const sent: unknown[] = [];
    f.history.subscribe({}, f.principal, read.identity, read.highWater, read.snapshotId, () => true, value => sent.push(value));
    const elsewhere = collect(f, "aeaea");
    elsewhere.admitting?.("circe", "WebFetch"); elsewhere.admitting?.("circe", "Bash");
    f.history.poll();
    await settled(f.history);
    expect(sent, "OTHER_CHATS_STAY_QUIET").toEqual([]);
    await f.writes.safetyEnd("aeaea");
    expect(f.db.query("SELECT tool_reuse FROM safety_collections WHERE id=?").get(other)).toEqual({ tool_reuse: '["circe"]' });
    expect(await flags(f.history, f), "OTHER_CHATS_FINDING_IS_NOT_DISCLOSED").toEqual([]);
  } finally { await f.close(); }
});

test("T11 reuse under an ID that can carry no entry join is not reported", async () => {
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("call:1", "WebFetch"); collector.admitting?.("call:1", "Bash");
    await f.writes.safetyEnd("voyage");
    expect(await flags(f.history, f), "UNJOINABLE_ID_IS_NOT_REPORTED").toEqual([]);
  } finally { await f.close(); }
});

test("T12 the end drops the tracker, also after the chat was scrubbed", async () => {
  for (const scrub of [false, true]) {
    const f = await safetyHistoryFixture();
    try {
      const collector = collect(f);
      collector.admitting?.("fetch", "WebFetch"); collector.admitting?.("fetch", "Bash");
      if (scrub) {
        const result = retireChat(f.db, { operationId: "odysseus-retire", principalId: f.principal.id, target: { sessionId: "ithaca" }, expected: { backendId: "claude", generation: 1 }, removableBackends: ["claude"], at: Date.now() });
        expect(result.status).toBe("retired");
      }
      await f.writes.safetyEnd("voyage").catch(() => {});
      expect(safetyQueue(f.db).attribution.size, "TRACKER_IS_DROPPED").toBe(0);
    } finally { await f.close(); }
  }
});

test("T13 past what the host tracks one by one, the whole turn reads as unknown; fallback names and nested calls", async () => {
  for (const shape of ["nine reused", "2001 tracked"] as const) {
    const f = await safetyHistoryFixture();
    try {
      const collector = collect(f);
      if (shape === "nine reused") for (let i = 0; i < 9; i++) { collector.admitting?.(`oar_${i}`, "Grep"); collector.admitting?.(`oar_${i}`, "Bash"); }
      else for (let i = 0; i < 2001; i++) collector.admitting?.(`oar_${i}`, "Grep");
      await f.writes.safetyEnd("voyage");
      expect(await flags(f.history, f), `${shape}: TURN_WIDE_UNKNOWN`).toEqual([{ bindingId: f.bindingId, toolUseIds: null }]);
      expect(f.db.query("SELECT tool_reuse FROM safety_collections").get(), shape).toEqual({ tool_reuse: '["*"]' });
    } finally { await f.close(); }
  }
  const f = await safetyHistoryFixture();
  try {
    const collector = collect(f);
    collector.admitting?.("fetch", "WebFetch");
    await collector.begin("fetch", "WebFetch", harbour);
    collector.admitting?.("fetch");
    await collector.lost?.("fetch", "unknown", new Error("The Pi report lost its tool name"));
    expect(await flags(f.history, f), "FALLBACK_NAME_IS_NO_SECOND_NAME").toEqual([]);
  } finally { await f.close(); }
  const g = await safetyHistoryFixture();
  try {
    const controller = new AbortController();
    const collector = createSafetyCollector(g.db, g.writes, { turnId: "voyage", bindingId: g.bindingId, backendId: "claude",
      sessionId: () => "ithaca", shellProxied: () => true, signal: controller.signal });
    const { hooks } = createPermissionWiring({
      req: { prompt: "Read the harbour report", signal: controller.signal, bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" }), inputSafety: collector } },
      allowedTools: ["WebFetch", "Read"], confirmPatterns: [], brainPath: g.root,
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, childEnv: {}, log() {},
    });
    const pre = (tool: string) => hooks!.PreToolUse!.filter(group => !group.matcher || new RegExp(`^(?:${group.matcher})$`).test(tool)).flatMap(group => group.hooks);
    const run = (tool: string, input: Record<string, unknown>, nested: boolean) => Promise.all(pre(tool).map(hook => hook({ hook_event_name: "PreToolUse",
      tool_name: tool, tool_use_id: "fetch", tool_input: input, cwd: g.root, session_id: "ithaca", transcript_path: "",
      ...(nested ? { agent_id: "scout", agent_type: "general-purpose" } : {}) } as never, "fetch", { signal: controller.signal })));
    await run("WebFetch", harbour, false);
    await run("Read", { file_path: "notes/loom.md" }, true);
    expect(await flags(g.history, g), "NESTED_REUSE_IS_OBSERVED").toEqual([{ bindingId: g.bindingId, toolUseIds: ["fetch"] }]);
  } finally { await g.close(); }
});

test("T15 each binding keeps its own budget: earlier full bindings never make a later one turn-wide", async () => {
  const f = await safetyHistoryFixture();
  try {
    await f.writes.safetyEnd("voyage");
    for (let turn = 0; turn < 9; turn++) {
      const turnId = `voyage_${turn}`;
      await f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId: "ithaca", principalId: f.principal.id, backendId: "claude", at: turn + 1 });
      await f.writes.safetyReady(turnId, "claude", 1);
      const collector = collect(f, turnId);
      for (let i = 0; i < (turn < 8 ? 8 : 1); i++) { collector.admitting?.(`oar_${turn}_${i}`, "Grep"); collector.admitting?.(`oar_${turn}_${i}`, "Bash"); }
      await f.writes.safetyEnd(turnId);
    }
    const reported = await flags(f.history, f);
    expect(reported?.length).toBe(9);
    expect(reported?.at(-1)?.toolUseIds, "LATER_BINDING_STAYS_PER_ID").toEqual(["oar_8_0"]);
  } finally { await f.close(); }
});

test("T16 a stored verdict that cannot be read keeps that binding's uncertainty", async () => {
  for (const damaged of ['{"oar"', '[1]', '["oar","*"]', '"oar"']) {
    const f = await safetyHistoryFixture();
    try {
      await f.writes.safetyEnd("voyage");
      f.db.query("UPDATE safety_collections SET tool_reuse=?").run(damaged);
      expect(await flags(f.history, f), `${damaged}: DAMAGED_VERDICT_IS_TURN_WIDE`).toEqual([{ bindingId: f.bindingId, toolUseIds: null }]);
    } finally { await f.close(); }
  }
});

test("T17 32 opted-in snapshots at the largest attribution still fit the snapshot budget", async () => {
  const f = await safetyHistoryFixture();
  try {
    for (let turn = 1; turn < 128; turn++) {
      await f.writes.safetyBegin({ turnId: `voyage_${turn}`, bindingId: crypto.randomUUID(), sessionId: "ithaca", principalId: f.principal.id, backendId: "claude", at: turn });
    }
    const widest = JSON.stringify(Array.from({ length: 8 }, (_, i) => `${"o".repeat(127)}${i}`));
    f.db.query("UPDATE safety_collections SET tool_reuse=?, ended=1").run(widest);
    safetyQueue(f.db).attribution.clear();
    const reads = [];let refused: unknown = null;
    try { for (let i = 0; i < 32; i++) reads.push(await page(f.history, f)); } catch (error) { refused = error; }
    expect({ reads: reads.length, refused: refused === null ? null : String(refused) }, "ATTRIBUTION_SPENDS_NO_SNAPSHOT_BUDGET").toEqual({ reads: 32, refused: null });
    expect(reads.at(-1)!.projection.attributionUnknown?.length, "WIDEST_ATTRIBUTION_IS_SERVED").toBe(128);
  } finally { await f.close(); }
});

test("T18 a failed end followed by retiring the chat drops the tracker", async () => {
  const f = await safetyHistoryFixture();
  try {
    await reused(f);
    f.db.run("CREATE TRIGGER sirens_hold_the_end BEFORE UPDATE OF ended ON safety_collections BEGIN SELECT RAISE(ABORT,'disk I/O error'); END");
    await f.writes.safetyEnd("voyage").catch(() => {});
    f.db.run("DROP TRIGGER sirens_hold_the_end");
    expect(safetyQueue(f.db).attribution.size, "FAILED_END_KEEPS_THE_TRACKER").toBe(1);
    const result = retireChat(f.db, { operationId: "odysseus-retire", principalId: f.principal.id, target: { sessionId: "ithaca" }, expected: { backendId: "claude", generation: 1 }, removableBackends: ["claude"], at: Date.now() });
    expect(result.status).toBe("retired");
    f.history.poll();
    expect(safetyQueue(f.db).attribution.size, "RETIRED_CHAT_DROPS_THE_TRACKER").toBe(0);
  } finally { await f.close(); }
});
