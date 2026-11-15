import { expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { GOVERNANCE_EVENT_SCHEMAS } from "../src/governance/events";
import { createPrincipal } from "../src/db/principals";
import { occurrence } from "../src/governance/occurrence";
import { openDialogue, bindDialogue } from "../src/ws/dialogue-storage";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";
import { createSafetyClient } from "../../ui-react/src/lib/safety-client";
import { createSafetyStore } from "../../ui-react/src/stores/safety-state";
import { SAFETY_READ_CAPABILITIES } from "../../ui-sdk/src/safety";
import type { BrainUiServices } from "../../ui-react/src/root";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
async function scout(f: Fixture) {
  openDialogue(f.db, { conversationId: "target-voice", principalId: f.principal.id, epoch: 1, providerId: "voice", sessionId: "ithaca" });
  const owner = openDialogue(f.db, { conversationId: "scout-voice", principalId: f.principal.id, epoch: 1, providerId: "voice" });
  await f.writes.safetyBegin({ turnId: "scout-turn", bindingId: "scout-binding", sessionId: null, principalId: f.principal.id, backendId: "claude", historyOwnerId: owner.id, at: 0 });
  await f.writes.safetyReady("scout-turn", "claude", 1);
  const c = occurrence("scout-binding", "tool_web_input", "C", "finalized");
  await f.writes.record({ kind: "taint", sessionId: null, turnId: "scout-turn", at: 0, actor: "interactive", model: null, profile: "governed",
    payload: { source: "web_fetch", tool: "WebFetch", detail: null, occurrence: c } });
  return c;
}
/**
 * Run a safety write while every safety read waits behind the fixture's hold, so
 * no poll sees the row with its local pending latch still set (#3723).
 */
async function settled<T>(f: Fixture, write: () => Promise<T>): Promise<T> {
  const quiet = f.hold();
  try { return await write(); } finally { quiet.release(); }
}
function reader() {
  const chat = createStore(() => ({ activeSessionId: "ithaca" })), safety = createSafetyStore(), sent: ClientMessage[] = [];
  const client = createSafetyClient({ stores: { chat, safety } } as unknown as BrainUiServices, message => { sent.push(message); return true; });
  client.frame({ type: "server_hello", protocolRev: 5, capabilities: { sessionSafetyHistory: true }, safetyCapabilities: SAFETY_READ_CAPABILITIES });
  const request = sent.find(m => m.type === "safety_read");
  if (!request || request.type !== "safety_read") throw new Error("Missing safety read");
  return { client, safety, sent, request };
}

test("adoption invalidates pinned paging membership while a fresh snapshot preserves every exact ID", async () => {
  const f = await safetyHistoryFixture();
  try {
    const c = await scout(f), a = await f.add("A"), b = await f.add("B");
    const first = await f.history.read(f.principal, { sessionId: "ithaca" }, null, 1);
    expect(first.projection.unresolvedCount).toBe(2);
    bindDialogue(f.db, "scout-voice", f.principal.id, "ithaca");
    await f.writes.bind("scout-turn", "ithaca");
    let failure: unknown;
    try { await f.history.read(f.principal, { sessionId: "ithaca" }, first.nextCursor); } catch (error) { failure = error; }
    expect(failure, "ADOPTION_INVALIDATES_PINNED_MEMBERSHIP").toMatchObject({ reason: "gap" });
    const response = await f.get(`?cursor=${first.nextCursor}`);
    expect(response.status).toBe(409);
    const fresh = await f.history.read(f.principal, { sessionId: "ithaca" });
    expect(fresh.projection.unresolvedCount).toBe(3);
    expect(fresh.records.map(r => r.id)).toEqual([c.id, a.id, b.id]);
  } finally { await f.close(); }
});

test("real WS subscriptions resync on alias adoption even before the safety binding advances revision", async () => {
  const f = await safetyHistoryFixture();
  try {
    const c = await scout(f), a = await f.add("A"), initial = await f.history.read(f.principal, { sessionId: "ithaca" });
    const ws = await f.connect();
    ws.send({ type: "safety_subscribe", version: 1, requestId: "adoption", identity: initial.identity, afterRevision: initial.highWater, snapshotId: initial.snapshotId });
    ws.send({ type: "ping", probeId: "subscription-barrier" }); await ws.until(m => m.type === "pong");
    bindDialogue(f.db, "scout-voice", f.principal.id, "ithaca");
    const continuity = await f.history.delta(f.principal, initial.identity, initial.highWater, initial.snapshotId).then(() => "delivered", error => error.reason);
    expect(continuity, "ADOPTION_CANNOT_SKIP_PRE_WATERMARK_OCCURRENCES").toBe("gap");
    f.history.poll();
    const frame = await ws.until(m => m.type === "safety_unavailable" || m.type === "safety_update");
    expect(frame, "ADOPTED_OLD_ROWS_REQUIRE_EXPLICIT_RESYNC").toMatchObject({ type: "safety_unavailable", reason: "gap" });
    // Reading the newly visible membership at the same revision must not let
    // an older client borrow the new snapshot's anchor.
    const fresh = await f.history.read(f.principal, { sessionId: "ithaca" });
    expect(fresh.highWater).toBe(initial.highWater);
    expect(fresh.records.map(r => r.id)).toEqual([c.id, a.id]);
    ws.send({ type: "safety_subscribe", version: 1, requestId: "old-anchor", identity: initial.identity, afterRevision: initial.highWater, snapshotId: initial.snapshotId });
    expect(await ws.until(m => m.type === "safety_unavailable")).toMatchObject({ requestId: "old-anchor", reason: "gap" });
    ws.send({ type: "safety_subscribe", version: 1, requestId: "new-anchor", identity: fresh.identity, afterRevision: fresh.highWater, snapshotId: fresh.snapshotId });
    await settled(f, () => f.add("B")); f.history.poll();
    const update = await ws.until(m => m.type === "safety_update" && m.update.projection.unresolvedCount === 3);
    expect(update.type === "safety_update" && update.update.projection.unresolvedCount).toBe(3);
    await f.writes.bind("scout-turn", "ithaca");
  } finally { await f.close(); }
});

test("final HTTP delivery rechecks adoption membership after the read has completed", async () => {
  const f = await safetyHistoryFixture();
  try {
    await scout(f); await f.add("A");
    const read = f.history.read.bind(f.history);
    f.history.read = async (...args) => {
      const page = await read(...args);
      bindDialogue(f.db, "scout-voice", f.principal.id, "ithaca");
      return page;
    };
    expect((await f.get()).status, "FINAL_DELIVERY_RECHECKS_ADOPTION_MEMBERSHIP").toBe(409);
  } finally { await f.close(); }
});

test("subscription anchors bind principal, identity and watermark and expire after a held delta read", async () => {
  const f = await safetyHistoryFixture();
  try {
    await f.add("A");
    const initial = await f.history.read(f.principal, { sessionId: "ithaca" });
    if (!("sessionId" in initial.identity)) throw new Error("Missing canonical identity");
    const ws = await f.connect();
    for (const forged of [
      { identity: initial.identity, afterRevision: String(BigInt(initial.highWater) + 1n) },
      { identity: { ...initial.identity, historyGeneration: "2" }, afterRevision: initial.highWater },
    ]) {
      ws.send({ type: "safety_subscribe", version: 1, requestId: "forged-anchor", snapshotId: initial.snapshotId, ...forged });
      expect(await ws.until(m => m.type === "safety_unavailable"), "SNAPSHOT_ANCHOR_BINDS_EXACT_HISTORY_AND_REVISION").toMatchObject({ reason: "gap" });
    }
    const foreign = createPrincipal(f.db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
    const other = await f.connect(await f.cookieFor(foreign));
    other.send({ type: "safety_subscribe", version: 1, requestId: "foreign-anchor", snapshotId: initial.snapshotId, identity: initial.identity, afterRevision: initial.highWater });
    expect(await other.until(m => m.type === "safety_unavailable"), "SNAPSHOT_ANCHOR_BINDS_EXACT_PRINCIPAL").toMatchObject({ reason: "gap" });
    expect(other.frames.some(m => m.type === "safety_history" || m.type === "safety_update")).toBe(false);
    const held = f.hold();
    const pending = f.history.delta(f.principal, initial.identity, initial.highWater, initial.snapshotId).then(() => "delivered", error => error.reason);
    await held.arrived; f.advance(300001); held.release();
    expect(await pending, "DELTA_ANCHOR_RECHECKS_EXPIRY_AFTER_WAIT").toBe("expired");
  } finally { await f.close(); }
});

test("every production taint source including Apify survives authenticated snapshots and live deltas", async () => {
  const f = await safetyHistoryFixture();
  try {
    const sources = GOVERNANCE_EVENT_SCHEMAS.taint.payload.shape.source.options;
    for (const source of sources) {
      await f.writes.record({ kind: "taint", sessionId: "ithaca", turnId: "voyage", at: 0, actor: "interactive", model: null, profile: "governed",
        payload: { source, tool: "brain_apify_results", detail: null, occurrence: occurrence(f.bindingId, "compute_input", source, "finalized") } });
    }
    const response = await f.get();
    expect(response.status, "ALL_PRODUCTION_SOURCES_REMAIN_READABLE").toBe(200);
    const body = await response.json();
    expect(body.records.map((r: { source: string }) => r.source).sort()).toEqual([...sources].sort());
    const ws = await f.connect();
    ws.send({ type: "safety_read", version: 1, requestId: "sources", target: { sessionId: "ithaca" } });
    const initial = await ws.until(m => m.type === "safety_history" || m.type === "safety_unavailable");
    expect(initial.type, "SUPPORTED_APIFY_WS_MUST_REMAIN_READABLE").toBe("safety_history");
    if (initial.type !== "safety_history") throw new Error("Missing source snapshot");
    ws.send({ type: "safety_subscribe", version: 1, requestId: "sources", identity: initial.page.identity, afterRevision: initial.page.highWater, snapshotId: initial.page.snapshotId });
    const observed = occurrence(f.bindingId, "compute_input", "later-apify", "finalized");
    await settled(f, () => f.writes.record({ kind: "taint", sessionId: "ithaca", turnId: "voyage", at: 0, actor: "interactive", model: null, profile: "governed",
      payload: { source: "apify_result", tool: "brain_apify_results", detail: null, occurrence: observed } }));
    f.history.poll();
    const delta = await ws.until(m => m.type === "safety_unavailable" || m.type === "safety_update" && m.update.records.some(r => r.id === observed.id));
    expect(delta.type, "SUPPORTED_APIFY_DELTA_MUST_REMAIN_READABLE").toBe("safety_update");
    expect(delta.type === "safety_update" && delta.update.records.map(r => r.id)).toContain(observed.id);
    expect(f.starts()).toBe(0);
  } finally { await f.close(); }
});

test("duplicate and newer old-subscription updates preserve an in-progress client snapshot", async () => {
  const f = await safetyHistoryFixture(), r = reader();
  try {
    await f.add("A"); await f.add("B");
    const first = await f.history.read(f.principal, { sessionId: "ithaca" }, null, 1);
    r.client.frame({ type: "safety_history", requestId: r.request.requestId, page: first });
    const reads = r.sent.length;
    const old = { version: 1 as const, identity: first.identity, fromRevision: "0", toRevision: first.highWater, projection: first.projection, records: first.records };
    expect(r.safety.getState().update(old), "PARTIAL_STORE_IGNORES_OLDER_UPDATE").toBe(true);
    r.client.frame({ type: "safety_update", update: old });
    await f.add("C");
    r.client.frame({ type: "safety_update", update: await f.history.delta(f.principal, first.identity, first.highWater, first.snapshotId) });
    expect(r.safety.getState().projection?.unresolvedCount, "DUPLICATE_MUST_PRESERVE_PARTIAL_AGGREGATE").toBe(2);
    expect(r.safety.getState().snapshotId).toBe(first.snapshotId);
    expect(r.sent.length).toBe(reads);
    const last = await f.history.read(f.principal, { sessionId: "ithaca" }, first.nextCursor);
    r.client.frame({ type: "safety_history", requestId: r.request.requestId, page: last });
    const subscription = r.sent.at(-1);
    expect(subscription).toMatchObject({ type: "safety_subscribe", snapshotId: first.snapshotId, afterRevision: first.highWater });
    r.client.frame({ type: "safety_update", update: await f.history.delta(f.principal, first.identity, first.highWater, first.snapshotId) });
    expect(r.safety.getState().projection?.unresolvedCount).toBe(3);
  } finally { r.client.dispose(); await f.close(); }
});

test("replayed completed pages preserve newer client aggregates and malformed continuations request recovery", async () => {
  const f = await safetyHistoryFixture(), r = reader();
  try {
    await f.add("A"); const first = await f.history.read(f.principal, { sessionId: "ithaca" });
    r.client.frame({ type: "safety_history", requestId: r.request.requestId, page: first });
    await f.add("B");
    const update = await f.history.delta(f.principal, first.identity, first.highWater, first.snapshotId);
    r.client.frame({ type: "safety_update", update });
    const sent = r.sent.length;
    r.client.frame({ type: "safety_update", update: { ...update, identity: { sessionId: "troy", historyOwnerId: "previous-owner", historyGeneration: "1" } } });
    expect(r.safety.getState().projection?.unresolvedCount, "PREVIOUS_IDENTITY_FRAME_PRESERVES_SELECTED_AGGREGATE").toBe(2);
    r.client.frame({ type: "safety_history", requestId: r.request.requestId, page: first });
    expect(r.safety.getState().page(r.request.requestId, first)).toBe(true);
    expect(r.safety.getState().projection?.unresolvedCount, "DUPLICATE_PAGE_MUST_PRESERVE_LIVE_AGGREGATE").toBe(2);
    expect(r.safety.getState().status).toBe("ready"); expect(r.sent.length).toBe(sent);
    r.client.refresh();
    const request = r.sent.at(-1);
    if (request?.type !== "safety_read") throw new Error("Missing refreshed read");
    r.client.frame({ type: "safety_history", requestId: request.requestId, page: { ...first, projection: { ...first.projection, evidenceRevision: "0" } } });
    expect(r.sent.at(-1)?.type, "MALFORMED_CURRENT_PAGE_STARTS_RECOVERY").toBe("safety_read");
    expect(r.sent.at(-1)).not.toEqual(request); expect(r.safety.getState().normal).toBe(false);
  } finally { r.client.dispose(); await f.close(); }
});
