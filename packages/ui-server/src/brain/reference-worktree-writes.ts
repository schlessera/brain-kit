/** Managed worktree database effects; pool and lifetime checks stay with the caller (#2999). */
import type { Database } from "bun:sqlite";

export function worktreeWrites(db: Database) {
  return {
    recordCheckpoint(id: string, worktreeId: string, pid: number, start: string, boot: string, pidNamespace: string, at: number) {
      db.query(`INSERT OR IGNORE INTO reference_worktree_checkpoints (id, worktree_id, owner_pid, owner_start, owner_boot, owner_pid_namespace, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, worktreeId, pid, start, boot, pidNamespace, at);
    },
    forgetCheckpoint(id: string) {
      db.query("DELETE FROM reference_worktree_checkpoints WHERE id = ?").run(id);
    },
    assess(facts: string, id: string) {
      db.query("UPDATE reference_worktrees SET cleanup = ? WHERE id = ?").run(facts, id);
    },
    startRemoval(id: string, trigger: string, premise: string, at: number) {
      db.query(`INSERT INTO reference_worktree_cleanups (worktree_id, trigger, state, premise, started_at) VALUES (?, ?, 'started', ?, ?)
      ON CONFLICT (worktree_id) DO UPDATE SET trigger = excluded.trigger, state = 'started', premise = excluded.premise, started_at = excluded.started_at, finished_at = NULL, error = NULL`).run(id, trigger, premise, at);
    },
    failRemoval(at: number, reason: string, id: string) {
      db.query("UPDATE reference_worktree_cleanups SET state = 'failed', finished_at = ?, error = ? WHERE worktree_id = ?").run(at, reason, id);
    },
    finishRemoval(state: string, at: number, id: string) {
      db.query("UPDATE reference_worktree_cleanups SET state = ?, finished_at = ? WHERE worktree_id = ?").run(state, at, id);
    },
    interruptRemoval(at: number, reason: string, id: string) {
      db.query("UPDATE reference_worktree_cleanups SET state = 'interrupted', finished_at = ?, error = ? WHERE worktree_id = ? AND state = 'started'").run(at, reason, id);
    },
    observeDeletion(at: number, id: string) {
      db.query("UPDATE reference_worktree_cleanups SET state = 'deleted', finished_at = ? WHERE worktree_id = ? AND state = 'started'").run(at, id);
    },
    forgetBaseline(id: string, checkpoint: string) {
      db.query("DELETE FROM reference_worktree_checkpoints WHERE id = ?").run(checkpoint);
      db.query("UPDATE reference_worktrees SET baseline = NULL WHERE id = ? AND baseline = ?").run(id, checkpoint);
    },
    observeReclamation(id: string) {
      db.query("UPDATE reference_worktree_cleanups SET state = 'reclaimed' WHERE worktree_id = ? AND state = 'deleted'").run(id);
    },
    recoverHolder(id: string, holder: string | null) {
      db.query("UPDATE reference_worktrees SET holder = NULL WHERE id = ? AND holder = ?").run(id, holder);
    },
    allocate(id: string, principalId: string, domain: string, repository: string, revision: string, commit: string, sourceRoot: string, allowance: number, at: number, accessedAt: number) {
      db.query(`INSERT INTO reference_worktrees (id, principal_id, domain, repository, revision, base_commit, source_root, baseline, allowance, state, created_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'creating', ?, ?)`).run(id, principalId, domain, repository, revision, commit, sourceRoot, allowance, at, accessedAt);
    },
    recordRoot(uuid: string | null, id: string) {
      db.query("UPDATE reference_worktrees SET root_uuid = ? WHERE id = ?").run(uuid, id);
    },
    recordBaseline(baseline: string, id: string) {
      db.query("UPDATE reference_worktrees SET baseline = ? WHERE id = ?").run(baseline, id);
    },
    activate(at: number, id: string) {
      db.query("UPDATE reference_worktrees SET state = 'active', accessed_at = ? WHERE id = ?").run(at, id);
    },
    discard(id: string) {
      db.query("DELETE FROM reference_worktrees WHERE id = ? AND state = 'creating'").run(id);
    },
    openGeneration(id: string, principalId: string, turnId: string, profile: string, path: string, pid: number, start: string, boot: string, pidNamespace: string, at: number) {
      db.query(`INSERT INTO reference_worktree_generations (id, principal_id, turn_id, profile, path, owner_pid, owner_start, owner_boot, owner_pid_namespace, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, principalId, turnId, profile, path, pid, start, boot, pidNamespace, at);
    },
    grant(generation: string, at: number, id: string) {
      db.query("UPDATE reference_worktrees SET holder = ?, accessed_at = ?, state = 'active', cleanup = NULL WHERE id = ?").run(generation, at, id);
    },
    renew(at: number, id: string) {
      db.query("UPDATE reference_worktrees SET accessed_at = ? WHERE id = ?").run(at, id);
    },
    release(at: number, id: string) {
      db.query("UPDATE reference_worktrees SET state = 'released', released_at = ? WHERE id = ?").run(at, id);
    },
    expire(id: string) {
      db.query("UPDATE reference_worktrees SET state = 'expired' WHERE id = ? AND state = 'active'").run(id);
    },
    adoptRoot(uuid: string, id: string) {
      db.query("UPDATE reference_worktrees SET root_uuid = ? WHERE id = ? AND root_uuid IS NULL").run(uuid, id);
    },
    closeGeneration(id: string, at: number) {
      db.transaction(() => {
        db.query("UPDATE reference_worktrees SET holder = NULL WHERE holder = ?").run(id);
        db.query("UPDATE reference_worktree_generations SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(at, id);
      }).immediate();
    },
  };
}
