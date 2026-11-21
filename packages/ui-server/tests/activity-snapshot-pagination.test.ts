import { expect, test } from "bun:test";
import type { ActivityRunDetail } from "@schlessera/brain-ui-sdk/protocol";
import { serverActivitySnapshotSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createActivityStore as createMirror } from "../../ui-react/src/stores/activity-state.js";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityRoutes } from "../src/routes/activity.js";
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

test("an oversized lifecycle is refetched in full without acknowledging a clipped row", async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), life = createTurnLifecycle(store, "ithaca-large", "ithaca", 1000, () => {}, () => 1100);
  for (let i = 0; i < 6500; i++) life.timer("journal")(`inspect-${i}`)();
  life.finish("success");
  const stream = createActivityStream(store), sent: string[] = [];
  const requests: Promise<unknown>[] = [];
  const routes = createActivityRoutes({ db, store });
  const mirror = createMirror({ api: { activityRun(runId: string) {
    const response = Promise.resolve(routes.request(`/activity/runs/${runId}`)).then(res => res.json()); requests.push(response); return response;
  } } } as Parameters<typeof createMirror>[0]);
  try {
    stream.handleSubscribe({ send: data => sent.push(data) }, { type: "activity_subscribe", view: "index" }, "odysseus");
    const frames = sent.map(text => serverActivitySnapshotSchema.parse(JSON.parse(text)));
    expect(frames.flatMap(frame => frame.lifecycles ?? []), "OVERSIZED_RECORD_IS_NOT_CLIPPED").toEqual([]);
    expect(frames.flatMap(frame => frame.refetch ?? []), "OVERSIZED_RECORD_REQUESTS_REFETCH").toEqual(["ithaca-large"]);
    for (const frame of frames) mirror.getState().applySnapshot(frame);
    expect(requests, "OVERSIZED_RECORD_FETCHES_FULL_REST_DETAIL").toHaveLength(1);
    await Promise.all(requests);
    expect(mirror.getState().lifecycles["ithaca-large"]!.subPhases, "REST_REFETCH_RETAINS_EVERY_STEP").toHaveLength(6500);
    expect(mirror.getState().highWater["lifecycle:ithaca-large"]).toBe(store.runHighWaterSeq("lifecycle:ithaca-large"));
    expect(frames.some(frame => "lifecycle:ithaca-large" in frame.highWaterSeq), "OVERSIZED_RECORD_HAS_NO_WATERMARK").toBe(false);
  } finally { mirror.dispose(); stream.close(); db.close(); }
});

test("index roots and their floors come from a consistent snapshot", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  store.startSpan({ spanId: "ithaca-root", runId: "ithaca-race", name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000 });
  const stream = createActivityStream({ ...store, openRootSpans() {
    const rows = store.openRootSpans(); store.endSpan("ithaca-root", { endedAt: 1200, outcome: "success" }); return rows;
  } });
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  const ws = { send(text: string) { const frame = JSON.parse(text); if (frame.type === "activity_snapshot") mirror.getState().applySnapshot(frame); else mirror.getState().applyDelta(frame); } };
  try {
    stream.handleSubscribe(ws, { type: "activity_subscribe", view: "index" }, "odysseus"); stream.pump();
    expect(mirror.getState().spans["ithaca-race"]!["ithaca-root"]!.outcome, "INDEX_ROOT_FLOOR_CANNOT_ACK_UNSEEN_TERMINAL").toBe("success");
  } finally { mirror.dispose(); stream.close(); db.close(); }
});

test("long run identities keep every frame bounded and preserve authoritative scope across pages", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), ids: string[] = [];
  for (let i = 0; i < 1400; i++) {
    const runId = `ithaca-${i}-${"帆".repeat(230)}`; ids.push(runId);
    store.startSpan({ spanId: `root-${i}`, runId, name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000 });
  }
  const stream = createActivityStream(store), mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  mirror.getState().applyDelta({ type: "activity_delta", runId: "ithaca-ghost", seq: 1,
    span: { spanId: "ghost", runId: "ithaca-ghost", name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000 } });
  mirror.getState().applyDelta({ type: "activity_delta", runId: ids.at(-1)!, seq: 2,
    span: { spanId: "root-1399", runId: ids.at(-1)!, name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000, attrs: { evidence: "newer Ithaca evidence" } } });
  try {
    const sent: string[] = [];
    stream.handleSubscribe({ send(text) { sent.push(text); } }, { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(text => Buffer.byteLength(text) <= MAX_WS_MESSAGE_BYTES), "SNAPSHOT_METADATA_IS_BOUNDED").toBe(true);
    for (const text of sent) mirror.getState().applySnapshot(serverActivitySnapshotSchema.parse(JSON.parse(text)));
    expect(mirror.getState().spans[ids.at(-1)!]!["root-1399"]!.attrs?.evidence, "SCOPE_EVICTION_WAITS_FOR_FINAL_PAGE").toBe("newer Ithaca evidence");
    expect(Object.keys(mirror.getState().spans).sort(), "PAGED_SCOPE_RETAINS_ALL_LIVE_RUNS").toEqual(ids.sort());
  } finally { mirror.dispose(); stream.close(); db.close(); }
});

for (const delivery of ["snapshot", "delta"] as const) test(`an oversized span ${delivery} refetches complete evidence without a clipped watermark`, async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store), sent: string[] = [];
  const evidence = "Ithaca ".repeat(100_000), requests: Promise<unknown>[] = [];
  const routes = createActivityRoutes({ db, store });
  const mirror = createMirror({ api: { activityRun(runId: string) {
    const response = Promise.resolve(routes.request(`/activity/runs/${runId}?include=payloads`)).then(res => res.json()); requests.push(response); return response;
  } } } as Parameters<typeof createMirror>[0]);
  const ws = { send(text: string) { sent.push(text); } };
  try {
    if (delivery === "delta") stream.handleSubscribe(ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    store.startSpan({ spanId: "ithaca-large-root", runId: "ithaca-large-run", name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000, attrs: { evidence } });
    if (delivery === "snapshot") stream.handleSubscribe(ws, { type: "activity_subscribe", view: "index" }, "odysseus"); else stream.pump();
    expect(sent.map(text => JSON.parse(text).type).every(type => type === "activity_snapshot"), "OVERSIZED_DELTA_REQUESTS_REFETCH").toBe(true);
    const frames = sent.map(text => serverActivitySnapshotSchema.parse(JSON.parse(text)));
    expect(frames.flatMap(frame => frame.spans), "OVERSIZED_SPAN_IS_NOT_CLIPPED").toEqual([]);
    expect(frames.flatMap(frame => frame.refetch ?? [])).toEqual(["ithaca-large-run"]);
    expect(frames.every(frame => !("ithaca-large-run" in frame.highWaterSeq)), "OVERSIZED_SPAN_HAS_NO_FLOOR").toBe(true);
    for (const frame of frames) mirror.getState().applySnapshot(frame);
    await Promise.all(requests);
    expect(mirror.getState().spans["ithaca-large-run"]!["ithaca-large-root"]!.attrs?.evidence, "REFETCH_SPAN_EVIDENCE_IS_COMPLETE").toBe(evidence);
  } finally { mirror.dispose(); stream.close(); db.close(); }
});

test("a refetch marker received during an in-flight read triggers a fresh consistent read", async () => {
  const reads: Array<(value: ActivityRunDetail) => void> = [];
  const mirror = createMirror({ api: { activityRun(_runId: string) { return new Promise<ActivityRunDetail>(resolve => reads.push(resolve)); } } } as Parameters<typeof createMirror>[0]);
  const marker = { type: "activity_snapshot" as const, view: "run" as const, runId: "ithaca-refetch", spans: [], events: [], highWaterSeq: {}, append: true, refetch: ["ithaca-refetch"] };
  const detail = (highWaterSeq: number) => ({ runId: "ithaca-refetch", detailPruned: false, spans: [], events: [], highWaterSeq });
  try {
    mirror.getState().applySnapshot(marker); mirror.getState().applySnapshot(marker);
    expect(reads).toHaveLength(1);
    reads[0]!(detail(1)); await Promise.resolve();
    expect(reads, "REFETCH_COALESCING_RETAINS_NEWER_MARKER").toHaveLength(2);
    reads[1]!(detail(2)); await Promise.resolve();
    expect(mirror.getState().highWater["ithaca-refetch"]).toBe(2);
  } finally { mirror.dispose(); }
});

test("root-only index reads omit child and event payloads while keeping a consistent floor", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    store.startSpan({ spanId: "ithaca-root", runId: "ithaca-run", name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000 });
    store.startSpan({ spanId: "ithaca-tool", runId: "ithaca-run", parentSpanId: "ithaca-root", name: "inspect_sail", kind: "tool", origin: "session", startedAt: 1100 });
    store.appendEvent("ithaca-tool", "tool_output", "Ithaca evidence");
    const snapshot = store.snapshotRun("ithaca-run", true)!;
    expect(snapshot.spans.map(span => span.spanId), "INDEX_READS_ONLY_THE_ROOT").toEqual(["ithaca-root"]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.highWaterSeq).toBe(store.runHighWaterSeq("ithaca-run"));
  } finally { db.close(); }
});

test("index root discovery cannot acknowledge an unseen second root in the same run", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  store.startSpan({ spanId: "ithaca-root", runId: "ithaca-run", name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1000 });
  const stream = createActivityStream({ ...store, openRootSpans() {
    const rows = store.openRootSpans();
    store.startSpan({ spanId: "ithaca-second-root", runId: "ithaca-run", name: "invoke_agent", kind: "turn", origin: "session", startedAt: 1100 });
    return rows;
  } });
  const mirror = createMirror({ api: {} } as Parameters<typeof createMirror>[0]);
  try {
    stream.handleSubscribe({ send(text) { mirror.getState().applySnapshot(serverActivitySnapshotSchema.parse(JSON.parse(text))); } },
      { type: "activity_subscribe", view: "index" }, "odysseus");
    expect(Object.keys(mirror.getState().spans["ithaca-run"]!).sort(), "INDEX_FLOOR_COVERS_ALL_OBSERVED_ROOTS").toEqual(["ithaca-root", "ithaca-second-root"]);
  } finally { mirror.dispose(); stream.close(); db.close(); }
});

test("a regular delta racing an oversized-record refetch cannot leave its other records missing", async () => {
  const reads: Array<(value: ActivityRunDetail) => void> = [];
  const mirror = createMirror({ api: { activityRun(_runId: string) { return new Promise<ActivityRunDetail>(resolve => reads.push(resolve)); } } } as Parameters<typeof createMirror>[0]);
  try {
    mirror.getState().applySnapshot({ type: "activity_snapshot", view: "run", runId: "ithaca-refetch", spans: [], events: [], highWaterSeq: {}, append: true, refetch: ["ithaca-refetch"] });
    const root = { spanId: "ithaca-root", runId: "ithaca-refetch", name: "invoke_agent", kind: "turn" as const, origin: "session" as const, startedAt: 1000 };
    mirror.getState().applyDelta({ type: "activity_delta", runId: "ithaca-refetch", seq: 2, span: { ...root, spanId: "ithaca-child", parentSpanId: "ithaca-root" } });
    reads[0]!({ runId: "ithaca-refetch", detailPruned: false, highWaterSeq: 1, spans: [root] }); await Promise.resolve();
    expect(reads, "STALE_REFETCH_RETRIES_AFTER_NEWER_DELTA").toHaveLength(2);
    reads[1]!({ runId: "ithaca-refetch", detailPruned: false, highWaterSeq: 2, spans: [root] }); await Promise.resolve();
    expect(mirror.getState().spans["ithaca-refetch"]!["ithaca-root"]).toEqual(root);
  } finally { mirror.dispose(); }
});
