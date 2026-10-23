/**
 * The journal observer's native manager for one managed worktree (#2430).
 * Checkpoints are read-only snapshots of that worktree in the reference pool,
 * deltas stay between its own checkpoints, and private reads use the fixed
 * worker-UID reader. Its changes feed the existing journal and scope owner;
 * the brain's checkpoints never cover a worktree.
 */
import type { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import type { NativeJournalManager } from "./native-journal-observer.js";

type Client = ReturnType<typeof createNativeBrainManagerClient>;
export type ReferenceWorktreeJournalPool = Pick<Client, "poolCheckpoint" | "poolDelta" | "poolRelease" | "poolReadCheckpoint" | "poolStatCheckpoint" | "poolListCheckpoint">;

/** Stable journal identity of a worktree path: a logical name, never a host or worker path. */
export const referenceWorktreeJournalPath = (worktreeId: string, path: string) => `reference-worktree://${worktreeId}/${path}`;
/** Journal scope of every managed worktree change. */
export const REFERENCE_WORKTREE_JOURNAL_SCOPE = "reference_worktree";

/** Durable ownership of each observation checkpoint, recorded before it exists and forgotten after release. */
export interface ReferenceWorktreeCheckpointLedger { record(id: string, worktreeId: string): void; forget(id: string): void }

export function referenceWorktreeJournalManager(pool: ReferenceWorktreeJournalPool, worktreeId: string, ledger?: ReferenceWorktreeCheckpointLedger): NativeJournalManager {
  return {
    async checkpoint(id, signal) {
      ledger?.record(id, worktreeId);
      const checkpoint = await pool.poolCheckpoint(id, worktreeId, signal);
      if (checkpoint.from !== worktreeId || !checkpoint.path || !checkpoint.root) throw new Error("Worktree checkpoint reply does not name its worktree.");
      return { id: checkpoint.id, path: checkpoint.path, uuid: checkpoint.root.uuid, transaction: checkpoint.transaction, readOnly: true };
    },
    delta: (from, to, signal) => pool.poolDelta(from, to, signal),
    async release(id, signal) { const result = await pool.poolRelease(id, signal); ledger?.forget(id); return result; },
    readCheckpoint: (id, path, maximum, workerUid, signal) => pool.poolReadCheckpoint(id, path, maximum, workerUid, signal),
    statCheckpoint: (id, path, workerUid, signal) => pool.poolStatCheckpoint(id, path, workerUid, signal),
    listCheckpoint: (id, path, workerUid, signal) => pool.poolListCheckpoint(id, path, workerUid, signal),
  };
}
