import { expect, test } from "bun:test";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";
import { holdSafetyRecovery } from "./helpers/hold-safety-recovery";
import { createSafetyStore } from "../../ui-react/src/stores/safety-state";
import type { SafetyPage, SafetyUpdate, SafetyUnavailable } from "@schlessera/brain-ui-sdk/protocol";

type Fixture = Awaited<ReturnType<typeof safetyHistoryFixture>>;
type DeltaReader = { readDelta(...args: unknown[]): Promise<unknown> };

/** Observe the real asynchronous SQL reads so assertions follow delivery. */
async function flush(f: Fixture, action = () => f.history.poll()) {
  const history = f.history as unknown as DeltaReader, original = history.readDelta;
  const pending: Promise<unknown>[] = [];
  history.readDelta = function (...args) {
    const result = original.apply(this, args); pending.push(result); return result;
  };
  try { action(); await Promise.allSettled(pending); await Promise.resolve(); await Promise.resolve(); }
  finally { history.readDelta = original; }
}
async function subscribe(f: Fixture, page: SafetyPage, send: (value: SafetyUpdate | SafetyUnavailable) => void) {
  await flush(f, () => f.history.subscribe({}, f.principal, page.identity, page.highWater, page.snapshotId, () => true, send));
}
function injectLossCommitFailure(f: Fixture) {
  // The retained loss is under test; the automatic reconciler must not clear it meanwhile.
  holdSafetyRecovery(f.db);
  f.db.exec("CREATE TABLE loss_commit_probe(id TEXT REFERENCES safety_records(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_loss_notice AFTER UPDATE OF failed ON safety_meta WHEN NEW.failed=1 BEGIN INSERT INTO loss_commit_probe VALUES('missing-raft'); END; CREATE TRIGGER fail_loss_notice_chat AFTER UPDATE OF failure ON safety_collections WHEN NEW.failure IS NOT NULL AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='fail_loss_notice') BEGIN INSERT INTO loss_commit_probe VALUES('missing-raft'); END");
}
async function lose(f: Fixture) {
  const error = await f.writes.safetyFail("voyage").then(() => null, error => error);
  expect(String(error)).toContain("FOREIGN KEY constraint failed");
}

for (const mode of ["loss-commit-rollback", "worker-closed"] as const) {
  test(`same-revision ${mode} restricts the store and invalidates a live subscription`, async () => {
    const f = await safetyHistoryFixture();
    try {
      const page = await f.history.read(f.principal, { sessionId: "ithaca" });
      const store = createSafetyStore(); store.getState().reset(true); store.getState().begin("initial"); store.getState().page("initial", page);
      expect(store.getState().normal).toBe(true);
      const events: (SafetyUpdate | SafetyUnavailable)[] = [];
      await subscribe(f, page, value => events.push(value)); expect(events).toEqual([]);
      if (mode === "loss-commit-rollback") { injectLossCommitFailure(f); await lose(f); }
      else {
        await f.writer.close();
        const error = await f.add("late").then(() => null, error => error);
        expect(String(error)).toContain("closed");
      }
      const update = await f.history.delta(f.principal, page.identity, page.highWater, page.snapshotId);
      expect(update.toRevision).toBe(page.highWater); expect(update.projection.reasons).toContain("recording_failed");
      store.getState().update(update);
      expect(store.getState().normal, "SAME_REVISION_FAILURE_UPDATE_IS_RESTRICTIVE").toBe(false);
      expect(store.getState().projection?.restriction).toBe("restricted");
      expect(store.getState().projection?.coverage.state).toBe("incomplete");
      store.getState().update({ ...update, projection: { ...update.projection, pendingCount: 1, reasons: [...update.projection.reasons, "recording_pending"] } });
      const stricter = store.getState().projection;
      expect(store.getState().update(update), "OLDER_SAME_REVISION_FAILURE_FRAME_IS_IDEMPOTENT").toBe(true);
      expect(store.getState().projection).toEqual(stricter);
      expect(store.getState().page("initial", page)).toBe(true);
      expect(store.getState().normal, "SAME_SNAPSHOT_OLD_PAGE_CANNOT_LOOSEN_FAILURE").toBe(false);
      // A normal frame captured before the loss cannot undo the restriction.
      store.getState().update({ ...update, projection: page.projection });
      expect(store.getState().normal, "SAME_REVISION_OLD_NORMAL_CANNOT_LOOSEN").toBe(false);
      await flush(f);
      expect(events, "SAME_REVISION_LOSS_INVALIDATES_SUBSCRIPTION").toEqual([{ version: 1, reason: "gap" }]);
      expect((await (await f.get()).json()).projection.restriction).toBe("restricted");
    } finally { await f.close(); }
  });
}

test("final authenticated HTTP and WS reads refuse an old normal page after a failed loss commit", async () => {
  const f = await safetyHistoryFixture();
  try {
    injectLossCommitFailure(f);
    const original = f.history.read.bind(f.history);
    let inject = true;
    f.history.read = async (...args) => { const page = await original(...args); if (inject) { inject = false; await lose(f); } return page; };
    const response = await f.get();
    expect(response.status, "FINAL_DELIVERY_REFUSES_UNRECORDED_LOSS").toBe(409);
    expect(await response.json()).toEqual({ version: 1, reason: "gap" });
    // A new read can publish the restrictive state rather than an old normal.
    const ws = await f.connect(); ws.send({ type: "safety_read", version: 1, requestId: "after-loss", target: { sessionId: "ithaca" } });
    const frame = await ws.until(m => m.type === "safety_history" || m.type === "safety_unavailable");
    expect(frame.type === "safety_history" && frame.page.projection.restriction).toBe("restricted");
    expect(f.writes.recordingAvailable(null, "ithaca")).toBe(false);
  } finally { await f.close(); }
});

test("authenticated real WS invalidates normal after recording loss without a durable revision advance", async () => {
  const f = await safetyHistoryFixture();
  try {
    const ws = await f.connect(); ws.send({ type: "safety_read", version: 1, requestId: "loss", target: { sessionId: "ithaca" } });
    const frame = await ws.until(m => m.type === "safety_history");
    if (frame.type !== "safety_history") throw new Error("Missing snapshot");
    ws.send({ type: "safety_subscribe", version: 1, requestId: "loss", identity: frame.page.identity, afterRevision: frame.page.highWater, snapshotId: frame.page.snapshotId });
    ws.send({ type: "ping", probeId: "subscribed" }); await ws.until(m => m.type === "pong"); await flush(f);
    injectLossCommitFailure(f); await lose(f); await flush(f);
    ws.send({ type: "ping", probeId: "loss-delivered" }); await ws.until(m => m.type === "pong" && m.probeId === "loss-delivered");
    const invalidation = ws.frames.filter(m => m.type === "safety_update" || m.type === "safety_unavailable");
    expect(invalidation, "REAL_WS_SAME_REVISION_LOSS_INVALIDATES_NORMAL").toEqual([{ type: "safety_unavailable", version: 1, reason: "gap", requestId: "loss" }]);
    const current = await f.history.read(f.principal, { sessionId: "ithaca" });
    expect(current.highWater).toBe(frame.page.highWater); expect(current.projection.restriction).toBe("restricted");
  } finally { await f.close(); }
});

test("a loss after the live SQL read resolves fences the final WS delivery", async () => {
  const f = await safetyHistoryFixture();
  try {
    const initial = await f.history.read(f.principal, { sessionId: "ithaca" }), events: (SafetyUpdate | SafetyUnavailable)[] = [];
    await subscribe(f, initial, value => events.push(value));
    await f.writes.safetyReady("voyage", "claude", 1); injectLossCommitFailure(f);
    const history = f.history as unknown as DeltaReader, original = history.readDelta;
    history.readDelta = async function (...args) { const value = await original.apply(this, args); await lose(f); return value; };
    try { await flush(f); } finally { history.readDelta = original; }
    expect(events, "FINAL_WS_DELIVERY_RECHECKS_RECORDING_LOSS").toEqual([{ version: 1, reason: "gap" }]);
  } finally { await f.close(); }
});

test("input submitted after the snapshot read cannot deliver an unqualified normal response", async () => {
  const f = await safetyHistoryFixture(); let recorded: Promise<unknown> | undefined;
  try {
    const original = f.history.read.bind(f.history);
    f.history.read = async (...args) => { const page = await original(...args); recorded = f.add("late-input"); return page; };
    const response = await f.get();
    expect(response.status, "FINAL_DELIVERY_REFUSES_UNACKNOWLEDGED_INPUT").toBe(409);
    expect(await response.json()).toEqual({ version: 1, reason: "gap" });
  } finally { await recorded; await f.close(); }
});
