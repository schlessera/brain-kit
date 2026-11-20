import { expect, test } from "bun:test";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import { createUiDb } from "../src/db/client";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";
import { contactedHosts, sessionTaint } from "../src/governance/session-taint";
import { connectedSafetySession } from "./helpers/connected-safety";

const repository = new URL("https://github.com/odysseus/ithaca");
const bridge = { emit() {}, requestPermission: async () => ({ behavior: "deny", message: "Declined" }) } as unknown as BackendBridge;
const input = (db: ReturnType<typeof createUiDb>) => ({ policy: resolveGovernancePolicy({ schema_version: 1 }), bridge,
  controller: new AbortController(), turnId: "turn-ithaca", sessionId: () => "ithaca", model: () => null,
  profile: "governed" as const, origin: "interactive" as const, governanceDb: db,
  record: (e: Parameters<typeof recordGovernanceEvent>[1]) => recordGovernanceEvent(db, e) });

test("managed reference audit never gives worker traffic a contacted-host grant in the same or next turn", async () => {
  const db = createUiDb(":memory:"); connectedSafetySession(db, "ithaca", "turn-ithaca");
  const proxy = await prepareTurnEgress(input(db));
  try {
    const acquisition = proxy.managedReference(repository, new AbortController().signal);
    expect(await acquisition.admit()).toBe(true); expect(acquisition.charge(12).ok).toBe(true); acquisition.finish("completed"); await proxy.settled();
    expect(sessionTaint(db, "turn-ithaca", "ithaca"), "REFERENCE_ACQUISITION_IS_NOT_A_MODEL_READ").toBeNull();
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["egress_connection"], limit: 10 })[0]?.payload)
      .toMatchObject({ managedReference: true, bytes: 12, host: "github.com" });
    expect(contactedHosts(db, "ithaca"), "REFERENCE_RECIPIENT_NOT_INHERITED_FROM_DURABLE_AUDIT").toEqual([]);
    recordGovernanceEvent(db, { kind: "taint", turnId: "turn-ithaca", sessionId: "ithaca", actor: "interactive", profile: "governed", model: null,
      payload: { source: "user_marked", tool: "Read", detail: "Untrusted chart" } });
    const later = proxy.managedReference(repository, new AbortController().signal);
    expect(await later.admit(), "REFERENCE_RECIPIENT_NOT_INHERITED_IN_CURRENT_TURN").toBe(false);
    expect(sessionTaint(db, "turn-ithaca", "ithaca")).not.toBeNull();
  } finally { proxy.stop(); db.close(); }
});

test("managed reference uses the final recorder-health fence after its transport waits", async () => {
  const db = createUiDb(":memory:"); connectedSafetySession(db, "ithaca", "turn-ithaca");
  let available = true;
  const safety = { read: () => ({ evidenceRevision: "0", trustRevision: "0", authorityEpoch: "0", scope: "ithaca", policyHash: null,
    restricted: false, recordingAvailable: available, authorityCurrent: true }), subscribe: () => () => {} };
  const proxy = await prepareTurnEgress({ ...input(db), bridge: { ...bridge, admissionSafety: safety } });
  try {
    const acquisition = proxy.managedReference(repository, new AbortController().signal);
    expect(await acquisition.admit()).toBe(true);
    available = false;
    expect(acquisition.commit(), "REFERENCE_FINAL_RECORDING_HEALTH_RECHECKED").toEqual({ok:false,reason:"unavailable"});
    expect(acquisition.charge(1)).toEqual({ok:false,reason:"unavailable"});
    await proxy.settled();
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["egress_connection"], limit: 10 })[0]?.payload)
      .toMatchObject({ managedReference: true, bytes: 0, outcome: "denied", reason: "egress_unavailable" });
  } finally { proxy.stop(); db.close(); }
});
