/** Maintenance receipt writes on the shared FULL write connection. */
import type { Database } from "bun:sqlite";
import type { StorageMaintenanceReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { isHumanOwner, isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { StorageUnavailable } from "./coordinator.js";
import { STORAGE_MAINTENANCE_LIMITS } from "./maintenance-limits.js";
import { recordStorageEvent } from "./events.js";
import { hashScope } from "./history-model.js";
export const url = import.meta.url;
export function setup(db: Database, { brain, self: SELF }: { brain: string; self: { pid: number; start: string } }, authorized = (id: string) => {
  const principal = resolvePrincipal(db, id);
  return !!principal && isHumanOwner(principal) && isUsablePrincipal(principal, Date.now());
}) {
  const authorize = (principal: string) => { if (!authorized(principal)) throw new StorageUnavailable(403, "Storage maintenance requires current human-owner access."); };
  // The events timeline keys brains like the history does.
  const events = hashScope(brain);
  function encoded(receipt: StorageMaintenanceReceipt, strict = false) {
    let text = JSON.stringify(receipt);
    if (strict && Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes) throw Error("receipt_item_budget");
    while (Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes && receipt.outcome?.items.length) { receipt.outcome.items.pop(); receipt.outcome.truncated = true; text = JSON.stringify(receipt); }
    if (Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes) throw Error("receipt_budget");
    return text + " ".repeat(STORAGE_MAINTENANCE_LIMITS.receiptBytes - Buffer.byteLength(text));
  }
  function write(receipt: StorageMaintenanceReceipt, strict = false) {
    const text = encoded(receipt, strict);
    db.transaction(() => {
      const { changes } = db.query("UPDATE storage_maintenance_operations SET state=?,receipt=? WHERE id=? AND brain=?").run(receipt.state, text, receipt.id, brain);
      // A terminal receipt records its finish once, at its own completion time,
      // and only after its recorded request: a receipt from before the
      // timeline, or one whose request found the kind full, never finishes in it.
      if (!changes || receipt.completedAt === null || ["waiting", "running"].includes(receipt.state)
        || !db.query("SELECT 1 FROM storage_events WHERE brain=? AND receipt=? AND phase='requested'").get(events, receipt.id)
        || db.query("SELECT 1 FROM storage_events WHERE brain=? AND receipt=? AND phase='finished'").get(events, receipt.id)) return;
      const { principal_id } = db.query("SELECT principal_id FROM storage_maintenance_operations WHERE id=? AND brain=?").get(receipt.id, brain) as { principal_id: string };
      recordStorageEvent(db, events, { kind: "maintenance", phase: "finished", at: receipt.completedAt, receipt: receipt.id, operation: receipt.operation, state: receipt.state, reason: receipt.reason, principal: principal_id });
    })();
    return receipt.outcome;
  }
  return {
    write,
    start(principal: string, result: StorageMaintenanceReceipt) {
      db.transaction(() => {
        authorize(principal);
        if (db.query("SELECT 1 FROM storage_maintenance_operations WHERE brain=? AND state IN ('waiting','running')").get(brain)) throw new StorageUnavailable(409, "Another Storage operation is active; read its receipt.");
        const { total } = db.query("SELECT count(*) AS total FROM storage_maintenance_operations WHERE brain=?").get(brain) as {total: number};
        if (total >= STORAGE_MAINTENANCE_LIMITS.receipts) throw new StorageUnavailable(503, "Maintenance receipt capacity reached; existing receipts are retained.");
        db.query("INSERT INTO storage_maintenance_operations (id,brain,principal_id,operation,state,pid,pid_start,requested_at,receipt) VALUES (?,?,?,?,?,?,?,?,?)").run(result.id, brain, principal, result.operation, result.state, SELF.pid, SELF.start, result.requestedAt, encoded(result));
        recordStorageEvent(db, events, { kind: "maintenance", phase: "requested", at: result.requestedAt, receipt: result.id, operation: result.operation, principal });
      }).immediate();
    },
    cancel(principal: string, id: string) {
      db.query("UPDATE storage_maintenance_operations SET cancel_requested=1 WHERE id=? AND brain=? AND principal_id=?").run(id, brain, principal);
    },
  };
}
