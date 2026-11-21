import { expect, test } from "bun:test";
import { serverActivitySnapshotSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createActivityStore as createMirror } from "../../ui-react/src/stores/activity-state.js";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityStream } from "../src/activity/stream.js";
import { MAX_WS_MESSAGE_BYTES } from "../src/ws/shrink.js";

test("a new subscriber receives every large lifecycle and only acknowledges delivered lifecycle records", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const pinned = Date.UTC(2026, 6, 12);
  for (let i = 0; i < 100; i++) {
    const life = createTurnLifecycle(store, `ithaca-${i}`, "ithaca", pinned + i, () => {}, () => pinned + i);
    life.mark("backendInvokedAt");
    for (let name = 0; name < 32; name++) life.startupTiming.missing(`mcp_connect:ithaca-${name}-${"x".repeat(190)}`);
    life.finish("success");
  }
  const stream = createActivityStream(store), sent: string[] = [];
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  try {
    stream.handleSubscribe({ send: data => sent.push(data) }, { type: "activity_subscribe", view: "index" }, "odysseus");
    const frames = sent.map(text => serverActivitySnapshotSchema.parse(JSON.parse(text)));
    for (const frame of frames) mirror.getState().applySnapshot(frame);
    expect(Object.keys(mirror.getState().lifecycles).sort(), "SNAPSHOT_RETAINS_ALL_LIFECYCLES")
      .toEqual(Array.from({ length: 100 }, (_, i) => `ithaca-${i}`).sort());
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]!.append).not.toBe(true);
    for (const [index, frame] of frames.entries()) {
      expect(Buffer.byteLength(sent[index]!)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
      if (index) expect(frame.append).toBe(true);
      expect(Object.keys(frame.highWaterSeq).filter(id => id.startsWith("lifecycle:")).sort(), "LIFECYCLE_WATERMARKS_MATCH_DELIVERED_RECORDS")
        .toEqual((frame.lifecycles ?? []).map(life => life.lifecycleId).sort());
      for (const life of frame.lifecycles ?? []) {
        expect(life.backendMissingEvidence).toHaveLength(32);
        expect(frame.highWaterSeq[life.lifecycleId]).toBe(store.runHighWaterSeq(life.lifecycleId));
      }
    }
    // Snapshot floors discard already-delivered deltas without losing records.
    for (const life of store.lifecycles()) mirror.getState().applyDelta({ type: "activity_delta", runId: life.lifecycleId,
      seq: store.runHighWaterSeq(life.lifecycleId), lifecycle: { ...life, reason: "stale Ithaca evidence" } });
    expect(Object.values(mirror.getState().lifecycles).map(life => life.reason)).toEqual(Array(100).fill(null));
  } finally { mirror.dispose(); stream.close(); db.close(); }
});

test("mixed large span and event snapshots retain all records through the client mirror", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), pinned = Date.UTC(2026, 6, 12);
  const evidence = "Ithaca ".repeat(900);
  store.startSpan({ spanId: "ithaca-root", runId: "ithaca-run", name: "invoke_agent", kind: "turn", origin: "session", startedAt: pinned });
  for (let i = 0; i < 100; i++) {
    store.startSpan({ spanId: `ithaca-child-${i}`, runId: "ithaca-run", parentSpanId: "ithaca-root", name: "inspect_sail",
      kind: "tool", origin: "session", startedAt: pinned, attrs: { evidence } });
    store.appendEvent("ithaca-root", "ithaca-evidence", { evidence });
  }
  const stream = createActivityStream(store), sent: string[] = [];
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  try {
    stream.handleSubscribe({ send: data => sent.push(data) }, { type: "activity_subscribe", view: "run", runId: "ithaca-run" }, "odysseus");
    for (const text of sent) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
      mirror.getState().applySnapshot(serverActivitySnapshotSchema.parse(JSON.parse(text)));
    }
    expect(Object.keys(mirror.getState().spans["ithaca-run"]!), "SNAPSHOT_RETAINS_SPANS_AND_EVENTS").toHaveLength(101);
    expect(mirror.getState().events["ithaca-root"]).toHaveLength(100);
    expect(mirror.getState().spans["ithaca-run"]!["ithaca-child-99"]!.attrs?.evidence).toBe(evidence);
  } finally { mirror.dispose(); stream.close(); db.close(); }
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

test("an older ActivityStore without atomic reads uses a floor captured before its lifecycle", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const life = createTurnLifecycle(store, "ithaca-legacy", "ithaca", 1000, () => {}, () => 1100);
  let inserted = false;
  const view = { ...store, lifecycleSnapshot: undefined, runHighWaterSeq(id: string) {
    const floor = store.runHighWaterSeq(id);
    if (!inserted) { inserted = true; life.recordHostEvent("follow_up", "odysseus"); }
    return floor;
  } };
  const stream = createActivityStream(view), sent: string[] = [];
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  try {
    stream.handleSubscribe({ send: data => sent.push(data) }, { type: "activity_subscribe", view: "index" }, "odysseus");
    const frame = serverActivitySnapshotSchema.parse(JSON.parse(sent[0]!));
    mirror.getState().applySnapshot(frame);
    expect(frame.highWaterSeq["lifecycle:ithaca-legacy"], "LEGACY_STORE_FLOOR_PRECEDES_ROW").toBe(1);
    expect(mirror.getState().lifecycles["ithaca-legacy"]!.hostEvents)
      .toEqual([{ kind: "follow_up", principalId: "odysseus", observedAt: 1100 }]);
  } finally { mirror.dispose(); stream.close(); db.close(); }
});
