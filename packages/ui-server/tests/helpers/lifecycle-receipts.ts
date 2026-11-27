/**
 * Turn lifecycles whose client receipts cover every way the joined receipt
 * can read (#4802): a valid receipt, one exactly at the byte cap, one a byte
 * over it, one that is not JSON, one never reported and a turn with no client
 * row at all, across two sessions.
 */
import type { Database } from "bun:sqlite";
import { MAX_CLIENT_TURN_RECEIPT_BYTES } from "@schlessera/brain-ui-sdk/schemas";
import type { ActivityStore } from "../../src/activity/store.js";
import { createTurnLifecycle } from "../../src/activity/turn-lifecycle.js";

const timing = { sendToFirstHostFrameMs: 4, sendToFirstContentFrameMs: 204, lastContentFrameToIdleMs: 8 };
/** JSON text of `timing` padded with trailing whitespace to exactly `bytes`. */
const padded = (bytes: number) => JSON.stringify(timing).padEnd(bytes, " ");

export const LIFECYCLE_TURNS = ["turn-valid", "turn-at-cap", "turn-over-cap", "turn-corrupt", "turn-unreported", "turn-anonymous"];

export function seedLifecycleReceipts(db: Database, store: ActivityStore) {
  LIFECYCLE_TURNS.forEach((id, index) => {
    const at = 1_000 + index * 1_000;
    const lifecycle = createTurnLifecycle(store, id, index % 2 ? "scheria" : "ithaca", at, () => {}, () => at + 300, id === "turn-anonymous" ? undefined : "odysseus");
    lifecycle.finish("success");
  });
  if (!store.writeClientReceipt?.("turn-valid", "odysseus", timing)) throw new Error("the valid client receipt was refused");
  const receipt = db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?");
  receipt.run(padded(MAX_CLIENT_TURN_RECEIPT_BYTES), "turn-at-cap");
  receipt.run(padded(MAX_CLIENT_TURN_RECEIPT_BYTES + 1), "turn-over-cap");
  receipt.run("{not json", "turn-corrupt");
}

/** Every `packageVersion` the records carry, as a placeholder: the golden outlives a version bump. */
const versionless = <T>(value: T): T => JSON.parse(JSON.stringify(value), (key, field) => key === "packageVersion" ? "<package version>" : field);

/** What every lifecycle read returns over the fixture, as the golden compares it. */
export function readLifecycleReceipts(store: ActivityStore) {
  return versionless({
    lifecycles: store.lifecycles(),
    session: store.lifecycles("ithaca"),
    lifecycle: Object.fromEntries(LIFECYCLE_TURNS.map(id => [id, store.lifecycle(id)])),
    snapshot: store.snapshotLifecycles!({ sessionId: "ithaca" }),
    snapshotAll: store.snapshotLifecycles!({}),
    snapshotTurn: store.snapshotLifecycles!({ turnId: "turn-over-cap" }),
    changes: store.lifecycleChangesSince(0),
  });
}
