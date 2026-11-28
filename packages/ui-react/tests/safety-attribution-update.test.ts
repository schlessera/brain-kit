/** The host's display-only attribution can change at an equal revision
 * (#4513): the store adopts it from the subscription's update, with no gap. */
import { expect, test } from "bun:test";
import type { SafetyPage } from "@schlessera/brain-ui-sdk/protocol";
import { createSafetyStore } from "../src/stores/safety-state";

const session = { sessionId: "ithaca", historyOwnerId: "odysseus_owner", historyGeneration: "1" };
const projection: SafetyPage["projection"] = { session, evidenceRevision: "7", unresolvedCount: 1, earliestUnresolvedId: "loom", pendingCount: 0,
  restriction: "restricted", reasons: ["unresolved"], coverage: { detectorVersion: 1, state: "complete", epochs: [], exclusions: [] } };
const page: SafetyPage = { version: 1, identity: session, snapshotId: "odyssey", cursor: null, highWater: "7", projection, records: [],
  nextCursor: null, snapshotComplete: true, detailPruned: false };

test("an attribution-only update at the snapshot's revision is adopted without a gap", () => {
  const store = createSafetyStore();
  store.getState().reset(true);
  store.getState().begin("odyssey_read");
  expect(store.getState().page("odyssey_read", page)).toBe(true);
  const attributionUnknown = [{ bindingId: "voyage", toolUseIds: ["fetch"] }];
  const accepted = store.getState().update({ version: 1, identity: session, fromRevision: "7", toRevision: "7", projection: { ...projection, attributionUnknown }, records: [] });
  expect(accepted).toBe(true);
  expect(store.getState().projection?.attributionUnknown, "EQUAL_REVISION_ATTRIBUTION_IS_ADOPTED").toEqual(attributionUnknown);
  expect({ status: store.getState().status, reason: store.getState().reason }, "NO_GAP").toEqual({ status: "ready", reason: null });
  const restricted = store.getState().update({ version: 1, identity: session, fromRevision: "7", toRevision: "7", projection: { ...projection, pendingCount: 1, attributionUnknown }, records: [] });
  expect(restricted, "AN_ENFORCEMENT_CHANGE_STILL_GAPS").toBe(false);
});
