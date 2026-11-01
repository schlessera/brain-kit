/** Case-18 S7 recovery only. Never repeat a tool call, grant, turn or case. */
import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { NativeBrainManagerError, type NativePoolRecord } from "../../packages/ui-sdk/src/server/native-brain-manager-protocol.js";
import { createReferenceWorktrees, ReferenceWorktreeError } from "../../packages/ui-server/src/brain/reference-worktrees.js";
import { CHANGING_POOL } from "./reference-worktree-release.js";

const LABEL = "REFERENCE_WORKTREE_ALLOCATION";
// Initial allocation plus two fresh allocations; no waiting or observation barrier.
export const ALLOCATION_ATTEMPTS = 3;
export function createFixtureWorktrees(options: Parameters<typeof createReferenceWorktrees>[0],
  note: (kind: string, facts: Record<string, unknown>) => void) {
  const { pool, db } = options;
  type Identity = { id: string; path: string | null; released?: NativePoolRecord };
  let pending: Identity[] | null = null;
  let cause: unknown, phase: "create" | "checkpoint" | null = null;
  const seen = new Set<string>();
  function track(id: string) {
    if (!pending) return;
    expect(seen.has(id), `${LABEL}_FRESH_IDENTITY`).toBe(false);
    seen.add(id);
    pending.push({ id, path: null });
  }
  const worktrees = createReferenceWorktrees({ ...options, pool: { ...pool,
    async poolCreate(...args) {
      if (args[1] === "worktree") track(args[0]);
      let result;
      try { result = await pool.poolCreate(...args); }
      catch (error) { cause = error; phase = "create"; throw error; }
      const entry = pending?.find(value => value.id === args[0]);
      if (entry) entry.path = result.path;
      return result;
    },
    async poolCheckpoint(...args) {
      track(args[0]);
      let result;
      try { result = await pool.poolCheckpoint(...args); }
      catch (error) { cause = error; phase = "checkpoint"; throw error; }
      const entry = pending?.find(value => value.id === args[0]);
      if (entry) entry.path = result.path;
      return result;
    },
    async poolRelease(...args) {
      const result = await pool.poolRelease(...args);
      const entry = pending?.find(value => value.id === args[0]);
      if (entry) entry.released = result;
      return result;
    },
  } });
  return { ...worktrees, async allocate(input: Parameters<typeof worktrees.allocate>[0]) {
    expect(pending, `${LABEL}_SERIAL_FIXTURE`).toBeNull();
    try {
      for (let attempt = 0; ; attempt++) {
        const identities: Identity[] = [];
        pending = identities; cause = undefined; phase = null;
        try { return await worktrees.allocate(input); }
        catch (error) {
          if (!(error instanceof ReferenceWorktreeError) || error.code !== "unavailable"
            || error.message !== `The worktree could not be created: ${CHANGING_POOL}`
            || !(cause instanceof NativeBrainManagerError) || cause.code !== "unavailable" || cause.message !== CHANGING_POOL) throw error;
          note("worktree-allocation-refused", { attempt, phase, identities, code: error.code, message: error.message });
          expect(identities.length, `${LABEL}_IDENTITIES_RECORDED`).toBeGreaterThan(0);
          // discard may warn and return the original refusal when cleanup failed. Prove it instead.
          const records: NativePoolRecord[] = [];
          for (let after: string | null = null; ;) {
            const page = await pool.listPoolRecovery(after); records.push(...page.records);
            if (!page.next) break;
            after = page.next;
          }
          for (const identity of identities) {
            const record = records.find(value => value.id === identity.id);
            expect(identity.released?.id, `${LABEL}_CLEANUP_RECEIPT`).toBe(identity.id);
            if (!record) expect(identity.released, `${LABEL}_FORGOTTEN_CHECKPOINT`)
              .toMatchObject({ purpose: "checkpoint", state: "reclaimed" });
            for (const retained of [identity.released, ...(record ? [record] : [])]) {
              expect(["deleted", "reclaimed"], `${LABEL}_FENCED`).toContain(retained?.state ?? "missing");
              expect({ path: retained?.path, access: retained?.access, view: retained?.view }, `${LABEL}_NO_LIVE_GRANT`)
                .toEqual({ path: null, access: null, view: null });
            }
            // Reclaimed checkpoints may be forgotten by the native manager; their receipt still fences them.
            expect(identity.path !== null && existsSync(identity.path), `${LABEL}_PATH_REMOVED`).toBe(false);
            expect(db.query("SELECT id FROM reference_worktrees WHERE id = ? OR baseline = ?").all(identity.id, identity.id),
              `${LABEL}_DISCARDED`).toEqual([]);
          }
          note("worktree-allocation-cleanup-proven", { attempt, identities });
          expect(attempt + 1, `${LABEL}_ATTEMPT_BOUND`).toBeLessThan(ALLOCATION_ATTEMPTS);
          note("worktree-allocation-deferred", { attempt, identities });
        }
      }
    } finally { pending = null; }
  } };
}
