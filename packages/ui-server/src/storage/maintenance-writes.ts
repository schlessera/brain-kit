/** Maintenance receipt writes on the shared FULL write connection. */
import type { Database } from "bun:sqlite";
import type { StorageMaintenanceReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { StorageUnavailable } from "./coordinator.js";
import { STORAGE_MAINTENANCE_LIMITS } from "./maintenance.js";
export const url = import.meta.url;
export function setup(db: Database, { brain, self: SELF }: { brain: string; self: { pid: number; start: string } }, authorized = (id: string) => {
  const principal = resolvePrincipal(db, id);
  return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now());
}) {
  const authorize = (principal: string) => { if (!authorized(principal)) throw new StorageUnavailable(403, "Storage maintenance requires current human-owner access."); };
  function encoded(receipt: StorageMaintenanceReceipt, strict = false) {
    let text = JSON.stringify(receipt);
    if (strict && Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes) throw Error("receipt_item_budget");
    while (Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes && receipt.outcome?.items.length) { receipt.outcome.items.pop(); receipt.outcome.truncated = true; text = JSON.stringify(receipt); }
    if (Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes) throw Error("receipt_budget");
    return text + " ".repeat(STORAGE_MAINTENANCE_LIMITS.receiptBytes - Buffer.byteLength(text));
  }
  function write(receipt: StorageMaintenanceReceipt, strict = false) {
    db.query("UPDATE storage_maintenance_operations SET state=?,receipt=? WHERE id=? AND brain=?").run(receipt.state, encoded(receipt, strict), receipt.id, brain);
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
      }).immediate();
    },
    cancel(principal: string, id: string) {
      db.query("UPDATE storage_maintenance_operations SET cancel_requested=1 WHERE id=? AND brain=? AND principal_id=?").run(id, brain, principal);
    },
  };
}
