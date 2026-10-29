/** Case-18 fixture recovery only; product release is allowed to retain unknown work. */
import { expect } from "bun:test";
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { NativePoolRecord } from "../../packages/ui-sdk/src/server/native-brain-manager-protocol.js";
import { referenceWorktreeDependents, type createReferenceWorktrees, type ReferenceWorktree, type ReferenceWorktreeRow } from "../../packages/ui-server/src/brain/reference-worktrees.js";

export const CHANGING_POOL = "Reference pool allocation changed between consistent reads; retry once writers settle.";
const identity = ({ id, purpose, from, allowanceBytes, root, path, view, access }: NativePoolRecord) => ({ id, purpose, from, allowanceBytes, root, path, view, access });
const ownership = ({ id, principal_id, domain, repository, revision, base_commit, source_root, baseline, allowance, root_uuid }: ReferenceWorktreeRow) =>
  ({ id, principal_id, domain, repository, revision, base_commit, source_root, baseline, allowance, root_uuid });

/** No clock/observation barrier: each explicit same-ID assessment must establish its own evidence. */
export async function settledWorktreeRelease(
  input: { db: Database; worktrees: ReturnType<typeof createReferenceWorktrees>; records: () => Promise<NativePoolRecord[]>;
    note: (kind: string, facts: Record<string, unknown>) => void },
  before: { record: NativePoolRecord; row: ReferenceWorktreeRow }, cleanup: ReferenceWorktree["cleanup"], label: string,
): Promise<ReferenceWorktree["cleanup"]> {
  const { db, worktrees, records, note } = input, id = before.record.id;
  note("worktree-release-assessed", { id, label, cleanup });
  // managed-worktrees.md#cleanup-eligibility-facts and reference-pool-accounting.md#consistent-observation.
  for (let attempt = 0; cleanup?.work === "unknown"; attempt++) {
    note("worktree-release-deferred", { id, label, attempt, cleanup });
    expect(cleanup, `${label}_DEFERRED_TRUTHFULLY`).toMatchObject({ reason: "released", owner: "none", work: "unknown", changedPaths: null,
      unverifiedPaths: null, sample: [], digest: null, eligible: false, error: CHANGING_POOL });
    const all = await records(), record = all.find(value => value.id === id), entry = worktrees.inventory().find(value => value.row.id === id);
    expect({ state: record?.state, present: record?.path ? existsSync(record.path) : false, receipt: entry?.cleanup,
      assessments: db.query("SELECT count(*) AS n FROM reference_worktree_checkpoints WHERE worktree_id = ?").get(id),
      sourceHeld: referenceWorktreeDependents(db, before.row.source_root), sourceState: all.find(value => value.id === before.row.source_root)?.state },
    `${label}_DEFERRED_RETAINED`).toEqual({ state: "writable", present: true, receipt: null, assessments: { n: 0 }, sourceHeld: true, sourceState: "sealed" });
    expect(record && identity(record), `${label}_DEFERRED_IDENTITY`).toEqual(identity(before.record));
    expect(entry && ownership(entry.row), `${label}_DEFERRED_OWNERSHIP`).toEqual(ownership(before.row));
    // Initial release plus at most three operations. Exhaustion still leaves the original worktree kept and charged.
    expect(attempt, `${label}_REASSESS_BOUND`).toBeLessThan(3);
    await worktrees.reassess(id, { remove: false });
    cleanup = worktrees.inventory().find(value => value.row.id === id)!.view.cleanup;
    note("worktree-release-reassessed", { id, label, attempt: attempt + 1, cleanup });
  }
  return cleanup;
}
