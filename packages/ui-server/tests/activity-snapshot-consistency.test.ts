import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverActivitySnapshotSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createActivityStore as createMirror } from "../../ui-react/src/stores/activity-state.js";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import { createActivityStream } from "../src/activity/stream.js";
import { MAX_WS_MESSAGE_BYTES } from "../src/ws/shrink.js";

const rootInput = (runId: string, at = 1000) => ({ spanId: `root-${runId}`, runId, sessionId: "ithaca", name: "invoke_agent", kind: "turn" as const, origin: "session" as const, startedAt: at });

function connection(store: ReturnType<typeof createActivityStore>, stream = createActivityStream(store)) {
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]), frames: any[] = [];
  const ws = { send(text: string) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    const frame = JSON.parse(text); frames.push(frame);
    if (frame.type === "activity_snapshot") mirror.getState().applySnapshot(serverActivitySnapshotSchema.parse(frame));
    else mirror.getState().applyDelta(frame);
  } };
  return { mirror, frames, stream, ws, close() { mirror.dispose(); stream.close(); } };
}

test("bounded backend additions keep 100 MCP-heavy lifecycles in the existing snapshot envelope", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), pinned = Date.UTC(2026, 6, 12);
  for (let i = 0; i < 100; i++) {
    const life = createTurnLifecycle(store, `ithaca-${i}`, "ithaca", pinned + i, () => {}, () => pinned + i);
    life.mark("backendInvokedAt");
    for (let name = 0; name < 32; name++) life.startupTiming.missing(`mcp_connect:ithaca-${name}-${"x".repeat(190)}`);
    life.finish("success");
  }
  const client = connection(store);
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(client.frames, "BACKEND_ADDITIONS_FIT_ONE_LEGACY_FRAME").toHaveLength(1);
    expect(Object.keys(client.mirror.getState().lifecycles), "BOUNDED_BACKEND_SNAPSHOT_RETAINS_100_LIFECYCLES").toHaveLength(100);
    for (const life of Object.values(client.mirror.getState().lifecycles)) {
      expect(life.backendMissingEvidence, "BACKEND_MCP_NAME_BYTES_ARE_BOUNDED").toEqual([]);
      expect(life.backendEvidenceOmitted).toBe(32);
    }
    expect(client.frames[0].refetch).toBeUndefined(); expect(client.frames[0].more).toBeUndefined();
  } finally { client.close(); db.close(); }
});


test("index snapshot cannot acknowledge another subscription's pending child or event", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db); store.startSpan(rootInput("ithaca-run"));
  const client = connection(store);
  client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "session", sessionId: "ithaca" }, "odysseus");
  store.startSpan({ ...rootInput("ithaca-run"), spanId: "ithaca-child", parentSpanId: "root-ithaca-run", kind: "tool" });
  store.appendEvent("ithaca-child", "inspect_sail", "Ithaca evidence");
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(client.frames.at(-1).highWaterSeq["ithaca-run"], "INDEX_FLOOR_EXCLUDES_OMITTED_SUBSCRIPTIONS").toBe(1);
    client.stream.pump();
    expect(client.mirror.getState().spans["ithaca-run"]!["ithaca-child"], "INDEX_REPLAYS_PENDING_SUBSCRIPTIONS").toBeDefined();
    expect(client.mirror.getState().events["ithaca-child"]).toHaveLength(1);
  } finally { client.close(); db.close(); }
});

test("the existing client retains a later chunk's cached child because the first frame covers the whole scope", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  for (let i = 0; i < 101; i++) store.startSpan(rootInput(`ithaca-${i}`, 1000 + i));
  store.startSpan({ ...rootInput("ithaca-0"), spanId: "ithaca-cached-child", parentSpanId: "root-ithaca-0", kind: "tool" });
  const client = connection(store);
  client.mirror.getState().applyDelta({ type: "activity_delta", runId: "ithaca-0", seq: 1, span: { ...rootInput("ithaca-0") } });
  client.mirror.getState().applyDelta({ type: "activity_delta", runId: "ithaca-0", seq: 2,
    span: { ...rootInput("ithaca-0"), spanId: "ithaca-cached-child", parentSpanId: "root-ithaca-0", kind: "tool" } });
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(client.frames).toHaveLength(2);
    for (const frame of client.frames) expect(Object.keys(frame.highWaterSeq), "EVERY_LEGACY_CHUNK_CARRIES_THE_WHOLE_SCOPE").toHaveLength(101);
    expect(client.mirror.getState().spans["ithaca-0"]!["ithaca-cached-child"], "PREVIOUS_CLIENT_RETAINS_CACHED_CHILD").toBeDefined();
    expect(Object.keys(client.mirror.getState().spans)).toHaveLength(101);
  } finally { client.close(); db.close(); }
});

test("a 420000-byte span still arrives in full through the existing wire shape", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), evidence = "x".repeat(420_000);
  store.startSpan({ ...rootInput("ithaca-run"), attrs: { evidence } });
  const client = connection(store);
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(client.frames[0].spans, "EXISTING_WIRE_DELIVERS_FITTING_RECORD").toHaveLength(1);
    expect(client.mirror.getState().spans["ithaca-run"]!["root-ithaca-run"]!.attrs?.evidence, "EXISTING_WIRE_RETAINS_FITTING_RECORD").toBe(evidence);
    expect(client.frames[0].refetch).toBeUndefined(); expect(client.frames[0].more).toBeUndefined();
  } finally { client.close(); db.close(); }
});

test("REST uses the scoped atomic reader when the single lifecycle reader is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ithaca-scoped-rest-")), path = join(dir, "ui.db");
  const routeDb = createUiDb(path), storeDb = createUiDb(path), store = createActivityStore(storeDb);
  const life = createTurnLifecycle(store, "ithaca-rest-scoped", "ithaca", 1000, () => {}, () => 1200);
  life.finish("success");
  let scopedReads = 0;
  const view = { ...store, lifecycleSnapshot: undefined,
    snapshotLifecycles(scope: Parameters<NonNullable<typeof store.snapshotLifecycles>>[0]) {
      scopedReads++; expect(scope).toEqual({ turnId: "ithaca-rest-scoped" });
      return store.snapshotLifecycles!(scope);
    },
    lifecycle() { throw new Error("REST must use the available atomic reader"); },
  };
  try {
    const response = await createActivityRoutes({ db: routeDb, store: view }).request("/activity/runs/ithaca-rest-scoped");
    const detail = await response.json();
    expect(response.status, "REST_SCOPED_ATOMIC_FALLBACK_SUCCEEDS").toBe(200);
    expect(scopedReads).toBe(1);
    expect(detail.lifecycle.outcome).toBe("success");
    expect(detail.lifecycleSeq, "REST_SCOPED_ATOMIC_FALLBACK_PRESERVES_SEQUENCE").toBe(2);
  } finally { routeDb.close(); storeDb.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy REST reads through a second SQLite connection do not claim a lifecycle sequence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ithaca-lifecycle-connections-")), path = join(dir, "ui.db");
  const routeDb = createUiDb(path), storeDb = createUiDb(path), store = createActivityStore(storeDb);
  const life = createTurnLifecycle(store, "ithaca-rest-race", "ithaca", 1000, () => {}, () => 1200);
  const legacy = { ...store, lifecycleSnapshot: undefined, snapshotLifecycles: undefined, lifecycle(id: string) { const row = store.lifecycle(id); life.finish("success"); return row; } };
  try {
    const response = await createActivityRoutes({ db: routeDb, store: legacy }).request("/activity/runs/ithaca-rest-race");
    const detail = await response.json();
    expect(detail.lifecycle.endedAt).toBeNull();
    expect(detail.lifecycleSeq, "LEGACY_CONNECTION_CANNOT_CLAIM_ATOMIC_SEQUENCE").toBeUndefined();
    expect(store.lifecycle("ithaca-rest-race")!.endedAt).toBe(1200);
  } finally { routeDb.close(); storeDb.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a lifecycle watermark cannot overtake its record when a writer commits during subscription", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const life = createTurnLifecycle(store, "ithaca-race", "ithaca", 1000, () => {}, () => 1100);
  const view = { ...store, snapshotLifecycles: undefined, lifecycles(...args: Parameters<typeof store.lifecycles>) {
    const rows = store.lifecycles(...args);
    life.recordHostEvent("follow_up", "odysseus");
    return rows;
  } };
  const stream = createActivityStream(view), mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  const ws = { send(text: string) {
    const frame = JSON.parse(text);
    if (frame.type === "activity_snapshot") mirror.getState().applySnapshot(serverActivitySnapshotSchema.parse(frame));
    else mirror.getState().applyDelta(frame);
  } };
  try {
    stream.handleSubscribe(ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    stream.pump();
    expect(mirror.getState().lifecycles["ithaca-race"]!.hostEvents, "LIFECYCLE_FLOOR_CANNOT_ACK_UNSEEN_DATA")
      .toEqual([{ kind: "follow_up", principalId: "odysseus", observedAt: 1100 }]);
  } finally { mirror.dispose(); stream.close(); db.close(); }
});


test("root-only index reads return their full consistent floor without loading child payloads", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    store.startSpan(rootInput("ithaca-run"));
    store.startSpan({ ...rootInput("ithaca-run"), spanId: "ithaca-child", parentSpanId: "root-ithaca-run", kind: "tool" });
    store.appendEvent("ithaca-child", "tool_output", "Ithaca evidence");
    const snapshot = store.snapshotRun("ithaca-run", true)!;
    expect(snapshot.spans.map(span => span.spanId)).toEqual(["root-ithaca-run"]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.highWaterSeq, "INDEX_READ_RETURNS_FULL_CONSISTENT_FLOOR").toBe(3);
    expect(snapshot.changeCursor).toBe(store.latestChangeCursor());
  } finally { db.close(); }
});

test("a clipped lifecycle snapshot replays complete records through the existing delta protocol", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), pinned = Date.UTC(2026, 6, 12);
  for (let i = 0; i < 100; i++) {
    const life = createTurnLifecycle(store, `ithaca-retained-${i}`, "ithaca", pinned + i, () => {}, () => pinned + i);
    for (let step = 0; step < 50; step++) life.timer("journal")(`inspect-${step}-${"x".repeat(60)}`)();
    life.finish("success");
  }
  let historyReads = 0;
  const client = connection({ ...store,
    changesSince(...args: Parameters<typeof store.changesSince>) { historyReads++; return store.changesSince(...args); },
    lifecycleChangesSince(...args: Parameters<typeof store.lifecycleChangesSince>) { historyReads++; return store.lifecycleChangesSince(...args); },
  });
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(client.frames[0].lifecycles.length).toBeLessThan(100);
    expect(Object.values(client.frames[0].highWaterSeq), "LIFECYCLE_REPAIR_FLOOR_PRECEDES_PAIRED_SEQUENCE").toEqual(Array(100).fill(1));
    expect(historyReads, "LIFECYCLE_REPAIR_DOES_NOT_SCAN_HISTORY").toBe(0);
    expect(client.frames.filter(frame => frame.type === "activity_delta" && frame.lifecycle), "MISSING_LIFECYCLES_REPAIR_WITHOUT_PUMP").toHaveLength(100);
    client.stream.pump();
    const records = Object.values(client.mirror.getState().lifecycles);
    expect(records, "CLIPPED_LIFECYCLES_REPLAY_WITHOUT_NEW_WRITES").toHaveLength(100);
    expect(records.every(record => record.subPhases?.length === 50), "REPLAY_RESTORES_COMPLETE_LIFECYCLE_STEPS").toBe(true);
  } finally { client.close(); db.close(); }
});

test("index reconnect after a live child delta accepts root updates already passed by the pump", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db); store.startSpan(rootInput("ithaca-reconnect"));
  const stream = createActivityStream(store), first = connection(store, stream), other = connection(store, stream);
  try {
    for (const client of [first, other]) stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    store.startSpan({ ...rootInput("ithaca-reconnect"), spanId: "ithaca-live-child", parentSpanId: "root-ithaca-reconnect", kind: "tool" });
    stream.pump();
    expect(first.mirror.getState().deltaSeq["ithaca-reconnect"]).toBe(2);
    stream.dropConnection(first.ws); first.mirror.getState().resetSubscriptions(); first.mirror.getState().bumpConnectionEpoch();
    store.patchSpan("root-ithaca-reconnect", { attrs: { evidence: "updated Ithaca evidence" } }); stream.pump();
    const otherCount = other.frames.length;
    stream.handleSubscribe(first.ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(first.mirror.getState().spans["ithaca-reconnect"]!["root-ithaca-reconnect"]!.attrs?.evidence,
      "RECONNECT_INDEX_ACCEPTS_ALREADY_PASSED_UPDATE").toBe("updated Ithaca evidence");
    expect(first.mirror.getState().spans["ithaca-reconnect"]!["ithaca-live-child"]).toBeDefined();
    expect(other.frames.length, "INDEX_RECONNECT_DOES_NOT_REPLAY_TO_OTHER_SOCKET").toBe(otherCount);
  } finally { first.close(); other.close(); db.close(); }
});

test("legacy lifecycle reconnect after a live delta accepts the terminal state already passed by the pump", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  let now = 1000; const life = createTurnLifecycle(store, "ithaca-legacy-reconnect", "ithaca", now, () => {}, () => now);
  const legacy = { ...store, lifecycleSnapshot: undefined, snapshotLifecycles: undefined }, stream = createActivityStream(legacy);
  const first = connection(legacy, stream), other = connection(legacy, stream);
  try {
    for (const client of [first, other]) stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    now = 1100; life.recordHostEvent("follow_up", "odysseus"); stream.pump();
    expect(first.mirror.getState().deltaSeq["lifecycle:ithaca-legacy-reconnect"]).toBe(2);
    stream.dropConnection(first.ws); first.mirror.getState().resetSubscriptions(); first.mirror.getState().bumpConnectionEpoch();
    now = 1200; life.finish("success"); stream.pump(); const otherCount = other.frames.length;
    stream.handleSubscribe(first.ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(first.mirror.getState().lifecycles["ithaca-legacy-reconnect"]!.outcome,
      "LEGACY_RECONNECT_ACCEPTS_PASSED_TERMINAL").toBe("success");
    expect(other.frames.length, "LEGACY_RECONNECT_DOES_NOT_REPLAY_TO_OTHER_SOCKET").toBe(otherCount);
  } finally { first.close(); other.close(); db.close(); }
});

test("legacy reconnect reads its sequence before a row that can race with terminal commit", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), life = createTurnLifecycle(store, "ithaca-legacy-race", "ithaca", 1000, () => {}, () => 1200);
  let completeOnRead = false;
  const legacy = { ...store, lifecycleSnapshot: undefined, snapshotLifecycles: undefined, lifecycle(id: string) {
    const row = store.lifecycle(id); if (completeOnRead) { completeOnRead = false; life.finish("success"); } return row;
  } };
  const stream = createActivityStream(legacy), first = connection(legacy, stream), other = connection(legacy, stream);
  try {
    for (const client of [first, other]) stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    life.recordHostEvent("follow_up", "odysseus"); stream.pump();
    expect(first.mirror.getState().deltaSeq["lifecycle:ithaca-legacy-race"]).toBe(2);
    stream.dropConnection(first.ws); completeOnRead = true;
    stream.handleSubscribe(first.ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(first.mirror.getState().lifecycles["ithaca-legacy-race"]!.outcome,
      "LEGACY_PREFIX_DOES_NOT_ACK_UNSEEN_TERMINAL").toBe("success");
    expect(first.frames.filter(frame => frame.type === "activity_snapshot").at(-1).highWaterSeq["lifecycle:ithaca-legacy-race"],
      "LEGACY_FALLBACK_FLOOR_IS_NOT_BELOW_DELIVERED").toBe(2);
  } finally { first.close(); other.close(); db.close(); }
});

test("a clipped lifecycle reconnect repairs only that socket without rewinding unrelated history", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), pinned = Date.UTC(2026, 6, 12);
  store.startSpan(rootInput("ithaca-old-finished")); store.endSpan("root-ithaca-old-finished", { outcome: "success", endedAt: 1200 });
  const stream = createActivityStream(store), first = connection(store, stream), other = connection(store, stream);
  try {
    for (const client of [first, other]) stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    for (let i = 0; i < 100; i++) {
      const life = createTurnLifecycle(store, `ithaca-socket-${i}`, "ithaca", pinned + i, () => {}, () => pinned + i);
      for (let step = 0; step < 50; step++) life.timer("journal")(`inspect-${step}-${"x".repeat(60)}`)();
      life.finish("success");
    }
    stream.pump();
    expect(first.mirror.getState().deltaSeq["lifecycle:ithaca-socket-0"]).toBe(2);
    stream.dropConnection(first.ws); first.mirror.getState().resetSubscriptions(); first.mirror.getState().bumpConnectionEpoch();
    const firstCount = first.frames.length, otherCount = other.frames.length;
    stream.handleSubscribe(first.ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(other.frames.length, "LIFECYCLE_REPAIR_IS_PRIVATE_TO_SUBSCRIBING_SOCKET").toBe(otherCount);
    expect(other.mirror.getState().spans["ithaca-old-finished"]).toBeUndefined();
    const repairs = first.frames.slice(firstCount).filter(frame => frame.type === "activity_delta" && frame.lifecycle);
    expect(repairs, "EVERY_CLIPPED_LIFECYCLE_HAS_ITS_OWN_REPAIR_DELTA").toHaveLength(100);
    expect(repairs.every(frame => frame.seq === 2 && frame.lifecycle.subPhases.length === 50), "LIFECYCLE_REPAIR_USES_ITS_PAIRED_SEQUENCE").toBe(true);
    expect(Object.values(first.mirror.getState().lifecycles).every(record => record.subPhases?.length === 50)).toBe(true);
  } finally { first.close(); other.close(); db.close(); }
});

test("index reconnect includes pending changes committed during its root read", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db); store.startSpan(rootInput("ithaca-read-race"));
  let writeDuringRead = false;
  const view = { ...store, snapshotRun(...args: Parameters<typeof store.snapshotRun>) {
    if (args[1] && writeDuringRead) {
      writeDuringRead = false;
      store.startSpan({ ...rootInput("ithaca-read-race"), spanId: "ithaca-racing-child", parentSpanId: "root-ithaca-read-race", kind: "tool" });
      store.patchSpan("root-ithaca-read-race", { attrs: { evidence: "current Ithaca root" } });
    }
    return store.snapshotRun(...args);
  } };
  const stream = createActivityStream(view), first = connection(view, stream), other = connection(view, stream);
  try {
    for (const client of [first, other]) stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    store.startSpan({ ...rootInput("ithaca-read-race"), spanId: "ithaca-seen-child", parentSpanId: "root-ithaca-read-race", kind: "tool" }); stream.pump();
    expect(first.mirror.getState().deltaSeq["ithaca-read-race"]).toBe(2);
    stream.dropConnection(first.ws); writeDuringRead = true; const otherCount = other.frames.length;
    stream.handleSubscribe(first.ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(first.mirror.getState().spans["ithaca-read-race"]!["ithaca-racing-child"], "INDEX_PENDING_READ_FOLLOWS_ROOT_SNAPSHOT").toBeDefined();
    expect(other.frames.length).toBe(otherCount + 2);
  } finally { first.close(); other.close(); db.close(); }
});

test("index reconnect accounts for the full pending tail across change batches", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  store.startSpan(rootInput("ithaca-pending-batches")); store.startSpan(rootInput("ithaca-other-run"));
  const stream = createActivityStream(store), first = connection(store, stream), other = connection(store, stream);
  try {
    for (const client of [first, other]) stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    store.startSpan({ ...rootInput("ithaca-pending-batches"), spanId: "ithaca-seen-child", parentSpanId: "root-ithaca-pending-batches", kind: "tool" }); stream.pump();
    expect(first.mirror.getState().deltaSeq["ithaca-pending-batches"]).toBe(2);
    stream.dropConnection(first.ws);
    for (let i = 0; i < 250; i++) store.patchSpan("root-ithaca-other-run", { attrs: { progress: i } });
    store.startSpan({ ...rootInput("ithaca-pending-batches"), spanId: "ithaca-late-child", parentSpanId: "root-ithaca-pending-batches", kind: "tool" });
    const otherCount = other.frames.length;
    stream.handleSubscribe(first.ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(first.mirror.getState().spans["ithaca-pending-batches"]!["ithaca-late-child"], "INDEX_PENDING_TAIL_COVERS_EVERY_BATCH").toBeDefined();
    expect(other.frames.length).toBe(otherCount + 251);
  } finally { first.close(); other.close(); db.close(); }
});
