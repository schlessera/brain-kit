import { watchdogMs } from "../../../../scripts/test-deadlines";
import type { openSqliteWriter } from "../../src/db/write-worker";
import type { GovernanceWrites } from "../../src/governance/event-writes";
import { occurrence } from "../../src/governance/occurrence";
import * as probe from "../fixtures/pending-safety-writer";

/** Keep a real connection occurrence reserved until the test releases the writer. */
export async function holdSiblingEvidence(writer: ReturnType<typeof openSqliteWriter>, writes: GovernanceWrites, turnId: string, bindingId: string, sessionId: string | null = null) {
  const channel = writer.channel(probe, undefined);
  await channel.ready;
  const entered = new Int32Array(new SharedArrayBuffer(4)), release = new Int32Array(new SharedArrayBuffer(4));
  const held = channel.call("hold", entered, release, watchdogMs(15000));
  const evidence = writes.firstTaint({ kind: "taint", turnId, sessionId, actor: "interactive", model: null, profile: "governed",
    payload: { source: "egress_connection", tool: null, detail: null, occurrence: occurrence(bindingId, "proxy_input", "ithaca-connection", "open") } });
  return async () => {
    Atomics.store(release, 0, 1); Atomics.notify(release, 0);
    await Promise.all([held, evidence]);
  };
}
