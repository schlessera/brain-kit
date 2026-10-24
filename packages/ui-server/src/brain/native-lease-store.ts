/**
 * Native root lease writes, run on the lease database's write worker at
 * `synchronous=FULL` (#2814). Each durable intent commits before its call
 * resolves, so the event loop awaits the fsync instead of blocking in it.
 * The lease manager keeps every read and every manager request.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { NativeBrainManagerError } from "@schlessera/brain-ui-sdk/internal";

import type { WireError, WriteProcedures } from "../db/write-worker.js";
import { SELF } from "./writer-gate.js";

export const url = import.meta.url;

/** This owner's identity: the manager instance's generation on this boot and PID namespace. */
export interface NativeLeaseOwner { generation: string; boot: string; pidNamespace: string }

type Lease = { kind: "checkpoint" | "stage"; checkpoint_uuid: string | null; stage_lower_id: string | null; stage_allowance: number | null; owner_pid: number; owner_start: string; owner_generation: string; owner_boot: string; owner_pid_namespace: string; state: "creating" | "sealed" | "deleting" };
type PoolLease = { purpose: string; from_id: string | null; allowance: number; state: "creating" | "held" | "releasing" };

export function reviveNativeLeaseError(wire: WireError): Error | undefined {
  return wire.name === "NativeBrainManagerError" ? new NativeBrainManagerError(wire.fields.code as never, wire.message) : undefined;
}

export function setup(db: Database, owner: NativeLeaseOwner): WriteProcedures {
  const row = (id: string) => db.query("SELECT * FROM native_root_leases WHERE id=?").get(id) as Lease | null;
  const poolRow = (id: string) => db.query("SELECT * FROM native_pool_leases WHERE id=?").get(id) as PoolLease | null;
  const mine = (lease: Lease) => lease.owner_pid === SELF.pid && lease.owner_start === SELF.start && lease.owner_generation === owner.generation && lease.owner_boot === owner.boot && lease.owner_pid_namespace === owner.pidNamespace;
  return {
    /** One statement, committed on its own; the rows it changed. */
    run(sql: string, params: SQLQueryBindings[]): number { return db.query(sql).run(...params).changes; },
    checkpointIntent(id: string): void {
      db.transaction(() => {
        const lease = row(id);
        if (lease && (!mine(lease) || lease.kind !== "checkpoint" || lease.state === "deleting")) throw new NativeBrainManagerError("unknown", "Checkpoint identity belongs to another live owner or deletion; no admission is authorized.");
        if (!lease) db.query("INSERT INTO native_root_leases(id,owner_pid,owner_start,owner_generation,owner_boot,owner_pid_namespace,state) VALUES (?,?,?,?,?,?,'creating')").run(id, SELF.pid, SELF.start, owner.generation, owner.boot, owner.pidNamespace);
      }).immediate();
    },
    /** The lower checkpoint's identity the stage must report. */
    stageIntent(id: string, checkpointId: string, allowanceBytes: number): string {
      let lowerUuid = "";
      db.transaction(() => {
        const lower = row(checkpointId), lease = row(id);
        if (!lower || lower.kind !== "checkpoint" || !mine(lower) || lower.state !== "sealed" || !lower.checkpoint_uuid) throw new NativeBrainManagerError("unknown", "Native stage requires this owner's retained sealed checkpoint lease.");
        if (lease && (!mine(lease) || lease.kind !== "stage" || lease.state === "deleting" || lease.stage_lower_id !== checkpointId || lease.stage_allowance !== allowanceBytes)) throw new NativeBrainManagerError("unknown", "Native stage identity belongs to another owner or deletion.");
        lowerUuid = lower.checkpoint_uuid;
        if (!lease) db.query("INSERT INTO native_root_leases(id,owner_pid,owner_start,owner_generation,owner_boot,owner_pid_namespace,state,kind,stage_lower_id,stage_allowance) VALUES (?,?,?,?,?,?,'creating','stage',?,?)").run(id, SELF.pid, SELF.start, owner.generation, owner.boot, owner.pidNamespace, checkpointId, allowanceBytes);
      }).immediate();
      return lowerUuid;
    },
    poolIntent(id: string, purpose: string, from: string | null, allowanceBytes: number): void {
      db.transaction(() => {
        const lease = poolRow(id);
        if (row(id)) throw new NativeBrainManagerError("unknown", "This identity already belongs to a checkpoint or stage lease.");
        if (lease && (lease.state === "releasing" || lease.purpose !== purpose || lease.from_id !== from || lease.allowance !== allowanceBytes))
          throw new NativeBrainManagerError("unknown", "Reference pool identity is recorded with another purpose, source, allowance or release.");
        if (from !== null && poolRow(from)?.state !== "held") throw new NativeBrainManagerError("unknown", "A reference snapshot needs this app's held source root.");
        if (!lease) db.query("INSERT INTO native_pool_leases(id,purpose,from_id,allowance,state) VALUES (?,?,?,?,'creating')").run(id, purpose, from, allowanceBytes);
      }).immediate();
    },
    poolCheckpointIntent(id: string, from: string, allowanceBytes: number): void {
      db.transaction(() => {
        const lease = poolRow(id), worktree = poolRow(from);
        if (row(id)) throw new NativeBrainManagerError("unknown", "This identity already belongs to a checkpoint or stage lease.");
        if (lease && (lease.state === "releasing" || lease.purpose !== "checkpoint" || lease.from_id !== from))
          throw new NativeBrainManagerError("unknown", "Reference pool identity is recorded with another purpose, source or release.");
        if (worktree?.purpose !== "worktree" || worktree.state !== "held") throw new NativeBrainManagerError("unknown", "A worktree checkpoint needs this app's held worktree.");
        if (!lease) db.query("INSERT INTO native_pool_leases(id,purpose,from_id,allowance,state) VALUES (?,'checkpoint',?,?,'creating')").run(id, from, allowanceBytes);
      }).immediate();
    },
  };
}
