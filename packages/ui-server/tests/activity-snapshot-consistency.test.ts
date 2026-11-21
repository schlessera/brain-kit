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

function connection(store: ReturnType<typeof createActivityStore>) {
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]), frames: any[] = [];
  const stream = createActivityStream(store);
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

test("shrunk snapshots advertise the highest complete event prefix and replay the dropped tail", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  store.startSpan(rootInput("ithaca-run"));
  store.startSpan({ ...rootInput("ithaca-run"), spanId: "ithaca-child", parentSpanId: "root-ithaca-run", kind: "tool" });
  const payload = { evidence: Array(60).fill("Ithaca ".repeat(15)) };
  for (let i = 0; i < 100; i++) store.appendEvent("ithaca-child", "inspect_sail", payload);
  // The stream starts after all writes: lowering a floor must also rewind
  // its replay baseline, rather than relying on another future write.
  const client = connection(store);
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "run", runId: "ithaca-run" }, "odysseus");
    const snapshot = client.frames[0];
    expect(snapshot.events.length).toBeLessThan(100);
    expect(snapshot.highWaterSeq["ithaca-run"], "SNAPSHOT_FLOOR_IS_HIGHEST_COMPLETE_PREFIX").toBe(2 + snapshot.events.length);
    client.stream.pump();
    expect(client.mirror.getState().events["ithaca-child"], "DROPPED_EVENTS_ARE_REPLAYED_WITHOUT_NEW_WRITES").toHaveLength(100);
    expect(client.mirror.getState().events["ithaca-child"]!.at(-1)!.payload).toEqual(payload);
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

test("legacy REST reads through a second SQLite connection do not claim a lifecycle sequence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ithaca-lifecycle-connections-")), path = join(dir, "ui.db");
  const routeDb = createUiDb(path), storeDb = createUiDb(path), store = createActivityStore(storeDb);
  const life = createTurnLifecycle(store, "ithaca-rest-race", "ithaca", 1000, () => {}, () => 1200);
  const legacy = { ...store, lifecycleSnapshot: undefined, lifecycle(id: string) { const row = store.lifecycle(id); life.finish("success"); return row; } };
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
  const view = { ...store, lifecycles(...args: Parameters<typeof store.lifecycles>) {
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


test("root-only index reads return a conservative floor without loading child payloads", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    store.startSpan(rootInput("ithaca-run"));
    store.startSpan({ ...rootInput("ithaca-run"), spanId: "ithaca-child", parentSpanId: "root-ithaca-run", kind: "tool" });
    store.appendEvent("ithaca-child", "tool_output", "Ithaca evidence");
    const snapshot = store.snapshotRun("ithaca-run", true)!;
    expect(snapshot.spans.map(span => span.spanId)).toEqual(["root-ithaca-run"]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.highWaterSeq, "INDEX_READ_FLOOR_PRECEDES_CHILD_SUBSCRIPTIONS").toBe(1);
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
  const client = connection(store);
  try {
    client.stream.handleSubscribe(client.ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(client.frames[0].lifecycles.length).toBeLessThan(100);
    expect(Object.values(client.frames[0].highWaterSeq), "CLIPPED_LIFECYCLES_ARE_NOT_ACKNOWLEDGED").toEqual(Array(100).fill(0));
    client.stream.pump();
    const records = Object.values(client.mirror.getState().lifecycles);
    expect(records, "CLIPPED_LIFECYCLES_REPLAY_WITHOUT_NEW_WRITES").toHaveLength(100);
    expect(records.every(record => record.subPhases?.length === 50), "REPLAY_RESTORES_COMPLETE_LIFECYCLE_STEPS").toBe(true);
  } finally { client.close(); db.close(); }
});
