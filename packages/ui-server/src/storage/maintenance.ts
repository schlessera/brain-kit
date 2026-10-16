/** Explicit host-owned housekeeping; durable identities never imply exactly-once filesystem effects. */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import type { StorageMaintenanceKind, StorageMaintenanceItem, StorageMaintenanceObservation, StorageMaintenanceReceipt, StorageMaintenanceRequest, StorageMaintenanceRow, StorageSnapshot } from "@schlessera/brain-ui-sdk/protocol";
import { BrainMaintenanceError, BrainMaintenanceUnavailable, type BrainClient } from "../brain/client.js";
import type { HostBoundary } from "../brain/host-boundary.js";
import { processAlive, SELF } from "../brain/writer-gate.js";
import { ScratchPruneSuspended, type ScratchPruner } from "../cron/scratch-prune.js";
import type { createInboxRuntime } from "../inbox/runtime.js";
import { StorageUnavailable, type StorageCoordinator } from "./coordinator.js";

export const STORAGE_MAINTENANCE_LIMITS = Object.freeze({ receipts: 1024, receiptBytes: 65_536, items: 200, milliseconds: 300_000 });
const runningHere = new Set<string>();
const descriptors = [
  { id: "pack-git", label: "Pack Git objects", owner: "core", scope: ["git"], effect: "Pack local objects and refs; history and reflogs remain." },
  { id: "prune-scratch", label: "Prune eligible scratch", owner: "core", scope: ["scratch"], effect: "Apply existing age/size policy; retained answer pins remain." },
  { id: "cleanup-staging", label: "Settled share staging cleanup", owner: "inbox", scope: ["staging"], effect: "Clean only owner-approved settled staging; live work and recovery remain protected." },
] as const;
type Row = { id: string; principal_id: string; operation: StorageMaintenanceKind; state: StorageMaintenanceReceipt["state"]; pid: number; pid_start: string; receipt: string };
const emptyOutcome = (): NonNullable<StorageMaintenanceReceipt["outcome"]> => ({ items: [], truncated: false, removed: null, failed: null, deferred: null, packed: null, pinnedFiles: null, pinnedBytes: null, overageBytes: null, suspended: false });
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const path = (value: unknown): value is string => typeof value === "string" && value.length <= 16384 && value.startsWith(".brain/scratch/") && !value.split("/").some(part => !part || part === "..") && !value.includes("\0");
function scratchOutcome(raw: string): NonNullable<StorageMaintenanceReceipt["outcome"]> {
  const value = JSON.parse(raw);
  if (value.action !== "prune" || !Array.isArray(value.removed) || !Array.isArray(value.failed) || !count(value.bytes) || !count(value.files)
    || !count(value.pinned?.files) || !count(value.pinned?.bytes) || !count(value.overageBytes)
    || value.removed.some((item: {path?: unknown}) => !path(item.path)) || value.failed.some((item: {path?: unknown}) => !path(item.path))) throw Error("scratch_report_unavailable");
  const items: StorageMaintenanceItem[] = [...value.removed.map((item: {path: string}) => ({ id: item.path, state: "cleaned" as const, reason: null })), ...value.failed.map((item: {path: string}) => ({ id: item.path, state: "failed" as const, reason: "owner_removal_failed" }))];
  return { ...emptyOutcome(), removed: value.removed.length, failed: value.failed.length, pinnedFiles: value.pinned.files, pinnedBytes: value.pinned.bytes, overageBytes: value.overageBytes, suspended: !!value.pinError, items: items.slice(0, 200), truncated: items.length > 200 };
}
function observation(snapshot: StorageSnapshot | null, scope: readonly string[]): StorageMaintenanceObservation | null {
  if (!snapshot) return null;
  const stores = snapshot.roots.filter(root => scope.includes(root.category)).map(root => ({ ...root, label: root.label.slice(0, 80), reason: root.reason?.slice(0, 160) ?? null }));
  const ids = new Set(stores.map(root => root.id));
  return { observedAt: snapshot.observedAt, coverage: stores.length ? stores.every(root => root.coverage === "complete") ? "complete" : "partial" : "unknown", basis: snapshot.basis,
    stores, capacities: snapshot.capacities.filter(capacity => capacity.rootIds.some(id => ids.has(id))).map(capacity => ({ ...capacity, reason: capacity.reason?.slice(0, 160) ?? null })), attribution: "concurrent-writers-possible" };
}
export function createStorageMaintenance(db: Database, options: {
  brainPath: string; storage: StorageCoordinator; brain: Pick<BrainClient, "storagePack">; scratch: ScratchPruner;
  inbox: Pick<ReturnType<typeof createInboxRuntime>, "cleanup">; boundary: Pick<HostBoundary, "status">;
  authorized(principal: string): boolean;
}) {
  const brain = realpathSync(options.brainPath), active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let closed = false;
  const authorize = (principal: string) => { if (!options.authorized(principal)) throw new StorageUnavailable(403, "Storage maintenance requires current human-owner access."); };
  const available = (kind: StorageMaintenanceKind) => kind === "cleanup-staging" ? !!options.inbox.cleanup : options.boundary.status().hostExecution === "worker" && options.boundary.status().available && (kind !== "pack-git" || !!options.brain.storagePack);
  const headroom = (kind: StorageMaintenanceKind): StorageMaintenanceReceipt["headroom"] => ({ requiredBytes: null, reservation: false,
    note: kind === "cleanup-staging" ? "Cleanup receipts and the operational database need writable capacity. Recovery is never discarded to make room." : "Temporary worker/output space is admitted by its existing owner. Packing may hold old and new packs together; required bytes depend on the workload and are not reserved." });
  const select = (id: string) => db.query("SELECT * FROM storage_maintenance_operations WHERE id=? AND brain=?").get(id, brain) as Row | null;
  function encoded(receipt: StorageMaintenanceReceipt, strict = false) {
    let text = JSON.stringify(receipt);
    if (strict && Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes) throw Error("receipt_item_budget");
    while (Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes && receipt.outcome?.items.length) { receipt.outcome.items.pop(); receipt.outcome.truncated = true; text = JSON.stringify(receipt); }
    if (Buffer.byteLength(text) > STORAGE_MAINTENANCE_LIMITS.receiptBytes) throw Error("receipt_budget");
    return text + " ".repeat(STORAGE_MAINTENANCE_LIMITS.receiptBytes - Buffer.byteLength(text));
  }
  function write(receipt: StorageMaintenanceReceipt, strict = false) {
    db.query("UPDATE storage_maintenance_operations SET state=?,receipt=? WHERE id=? AND brain=?").run(receipt.state, encoded(receipt, strict), receipt.id, brain);
  }
  function reconciled(row: Row): StorageMaintenanceReceipt {
    const receipt = JSON.parse(row.receipt) as StorageMaintenanceReceipt;
    if (["waiting", "running"].includes(row.state) && (!processAlive(row.pid, row.pid_start) || row.pid === SELF.pid && row.pid_start === SELF.start && !runningHere.has(`${brain}:${row.id}`))) {
      receipt.state = row.state === "waiting" ? "refused" : "unknown";
      receipt.reason = row.state === "waiting" ? "interrupted_before_owner" : "interrupted_owner_outcome_unknown"; receipt.completedAt = Date.now();
      // Inbox owns replay of its existing durable cleanup work. This request never re-dispatches it.
      if (row.operation === "cleanup-staging") for (const item of receipt.outcome?.items ?? []) {
        const owner = db.query("SELECT status FROM inbox_items WHERE id=?").get(item.id) as {status: string} | null;
        if (item.state === "running" && owner?.status === "done") item.state = "cleaned";
      }
      try { write(receipt); } catch { /* Existing durable intent remains; readback still describes uncertainty. */ }
    }
    return receipt;
  }
  function recover() { for (const row of db.query("SELECT * FROM storage_maintenance_operations WHERE brain=? AND state IN ('waiting','running')").all(brain) as Row[]) reconciled(row); }
  function receipt(principal: string, id: string) {
    authorize(principal); const row = select(id);
    if (!row || row.principal_id !== principal) throw new StorageUnavailable(404, "Maintenance receipt unavailable.");
    return reconciled(row);
  }
  async function execute(principal: string, result: StorageMaintenanceReceipt, controller: AbortController) {
    let ownerStarted = false;
    const assertAuthorized = () => { controller.signal.throwIfAborted(); authorize(principal); };
    const timer = setTimeout(() => controller.abort(), STORAGE_MAINTENANCE_LIMITS.milliseconds);
    const revocation = setInterval(() => { try { if (!options.authorized(principal) || (db.query("SELECT cancel_requested FROM storage_maintenance_operations WHERE id=?").get(result.id) as {cancel_requested: number} | null)?.cancel_requested) controller.abort(); } catch { controller.abort(); } }, 100);
    try {
      assertAuthorized();
      if (!available(result.operation)) { result.state = "refused"; result.reason = "owner_unavailable"; return; }
      result.before = observation(await options.storage.measure(principal, controller.signal), result.scope);
      assertAuthorized();
      if (result.operation === "pack-git" && result.before?.capacities.some(value => value.available === 0)) { result.state = "refused"; result.reason = "no_space"; return; }
      result.state = "running"; result.startedAt = Date.now(); result.outcome = emptyOutcome(); write(result);
      ownerStarted = true;
      if (result.operation === "pack-git") {
        const value = await options.brain.storagePack!({ signal: controller.signal, assertAuthorized, bounded: true }) as { schema_version?: number; action?: string; state?: string; packed?: unknown; reason?: string };
        if (value.schema_version !== 1 || value.action !== "pack" || !["complete", "partial", "refused"].includes(value.state ?? "") || value.packed !== null && !count(value.packed)) throw Error("packing_report_unavailable");
        result.outcome.packed = value.packed as number | null;
        result.state = value.state as "complete" | "partial" | "refused"; result.reason = value.reason === "no_space" ? "no_space" : result.state === "complete" ? null : "git_maintenance_incomplete";
      } else if (result.operation === "prune-scratch") {
        let raw: string;
        try { raw = await options.scratch.run({ signal: controller.signal, assertAuthorized, bounded: true }); }
        catch (error) { if (!(error instanceof BrainMaintenanceError) || error.exitCode !== 2) throw error; raw = error.stdout; }
        result.outcome = scratchOutcome(raw);
        result.state = result.outcome.suspended ? result.outcome.removed ? "partial" : "refused" : result.outcome.failed ? "partial" : "complete";
        result.reason = result.outcome.suspended ? "pins_unavailable" : result.outcome.overageBytes ? "pinned_overage" : result.outcome.failed ? "owner_removal_failed" : null;
      } else {
        const value = await options.inbox.cleanup!({ signal: controller.signal, assertAuthorized, onItem(item) {
          const previous = result.outcome!.items.find(value => value.id === item.id);
          if (previous) Object.assign(previous, item); else result.outcome!.items.push(item);
          write(result, true); // Item intent is durable before the owner removes its staging.
        } });
        result.outcome = { ...emptyOutcome(), items: value.items, removed: value.cleaned, failed: value.failed, deferred: value.deferred, truncated: value.truncated };
        result.state = value.cancelled ? value.cleaned ? "partial" : "cancelled" : value.failed ? "partial" : "complete";
        result.reason = value.cancelled ? "cancelled" : value.failed ? "cleanup_incomplete" : value.deferred ? "live_or_unsettled_items_retained" : null;
      }
    } catch (error) {
      result.state = error instanceof BrainMaintenanceUnavailable || error instanceof ScratchPruneSuspended ? "refused" : ownerStarted ? "unknown" : controller.signal.aborted ? "cancelled" : "refused";
      result.reason = error instanceof ScratchPruneSuspended ? "pins_refresh_incomplete" : error instanceof BrainMaintenanceUnavailable ? error.reason : ownerStarted ? "owner_outcome_unknown" : controller.signal.aborted ? "cancelled_or_revoked" : "owner_unavailable";
      if (error instanceof ScratchPruneSuspended && result.outcome) result.outcome.suspended = true;
    } finally {
      clearTimeout(timer); clearInterval(revocation);
      try { write(ownerStarted ? { ...result, state: "running" } : result); } catch { /* Retain the previously committed intent. */ }
      // A cancelled write can still have committed effects. Its fresh observation is independent.
      if (result.startedAt && options.authorized(principal) && !closed) {
        const after = new AbortController(), deadline = setTimeout(() => after.abort(), 36_000);
        try { result.after = observation(await options.storage.measure(principal, after.signal), result.scope); } catch { result.after = null; }
        finally { clearTimeout(deadline); }
      }
      result.completedAt = Date.now();
      try { write(result); } catch { /* Preserve running intent; readback reconciles to unknown, never retries. */ }
    }
  }
  return {
    list(principal: string): { operations: StorageMaintenanceRow[]; limits: typeof STORAGE_MAINTENANCE_LIMITS } {
      authorize(principal); recover();
      return { limits: STORAGE_MAINTENANCE_LIMITS, operations: descriptors.map(value => {
        const latest = db.query("SELECT * FROM storage_maintenance_operations WHERE brain=? AND principal_id=? AND operation=? ORDER BY requested_at DESC,rowid DESC LIMIT 1").get(brain, principal, value.id) as Row | null;
        return { ...value, scope: [...value.scope], available: available(value.id), reason: available(value.id) ? null : "owner_unavailable", headroom: headroom(value.id), latest: latest ? reconciled(latest) : null };
      }) };
    },
    start(principal: string, request: StorageMaintenanceRequest): StorageMaintenanceReceipt {
      authorize(principal);
      if (closed) throw new StorageUnavailable(503, "Maintenance is shutting down.");
      if (!/^[a-zA-Z0-9_-]{16,96}$/.test(request.id) || !descriptors.some(value => value.id === request.operation)) throw new StorageUnavailable(400, "Invalid maintenance operation.");
      recover();
      const existing = select(request.id);
      if (existing) {
        if (existing.principal_id !== principal || existing.operation !== request.operation) throw new StorageUnavailable(409, "Operation identity belongs to another request.");
        return reconciled(existing);
      }
      const descriptor = descriptors.find(value => value.id === request.operation)!;
      const result: StorageMaintenanceReceipt = { id: request.id, operation: request.operation, owner: descriptor.owner, scope: [...descriptor.scope], requestedAt: Date.now(), startedAt: null, completedAt: null, state: "waiting", reason: null, headroom: headroom(request.operation), before: null, after: null, outcome: null };
      db.transaction(() => {
        authorize(principal);
        if (db.query("SELECT 1 FROM storage_maintenance_operations WHERE brain=? AND state IN ('waiting','running')").get(brain)) throw new StorageUnavailable(409, "Another Storage operation is active; read its receipt.");
        const { total } = db.query("SELECT count(*) AS total FROM storage_maintenance_operations WHERE brain=?").get(brain) as {total: number};
        if (total >= STORAGE_MAINTENANCE_LIMITS.receipts) throw new StorageUnavailable(503, "Maintenance receipt capacity reached; existing receipts are retained.");
        db.query("INSERT INTO storage_maintenance_operations (id,brain,principal_id,operation,state,pid,pid_start,requested_at,receipt) VALUES (?,?,?,?,?,?,?,?,?)").run(result.id, brain, principal, result.operation, result.state, SELF.pid, SELF.start, result.requestedAt, encoded(result));
      }).immediate();
      const controller = new AbortController(); runningHere.add(`${brain}:${result.id}`);
      const pending = Promise.resolve().then(() => execute(principal, result, controller)).finally(() => { active.delete(result.id); runningHere.delete(`${brain}:${result.id}`); });
      active.set(result.id, { controller, promise: pending });
      return receipt(principal, result.id);
    },
    receipt,
    cancel(principal: string, id: string) { const result = receipt(principal, id); if (["waiting", "running"].includes(result.state)) db.query("UPDATE storage_maintenance_operations SET cancel_requested=1 WHERE id=? AND brain=? AND principal_id=?").run(id, brain, principal); active.get(id)?.controller.abort(); return result; },
    async idle() { await Promise.allSettled([...active.values()].map(value => value.promise)); },
    async close() { closed = true; for (const value of active.values()) value.controller.abort(); await Promise.allSettled([...active.values()].map(value => value.promise)); },
  };
}
export type StorageMaintenance = ReturnType<typeof createStorageMaintenance>;
