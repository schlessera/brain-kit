/** A receipt failure removes write access only to its checkout before worker launch. */
import { resolveWorkerProtection, type WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";

export function restrictFailedCheckouts(sandbox: WorkerSandbox, failed: readonly string[]): void {
  if (!failed.length) return;
  const original = sandbox.protection;
  const resolved = resolveWorkerProtection(sandbox.brain, {
    paths: [...(original?.paths.map(path => path.rel) ?? []), ...failed],
    // A failed checkout may contain symlinks or aliases that cannot be safely
    // exposed read-only. Mask its complete subtree using the existing guard.
    appeared: [...(original?.paths.filter(path => path.mode === "mask_directory" || path.mode === "mask_file").map(path => path.rel) ?? []), ...failed],
    folderPaths: sandbox.retainedFolders,
    prepare: false,
  });
  if (resolved.reason || failed.some(rel => !resolved.protection.paths.some(path => path.rel === rel && path.mode === "mask_directory"))) {
    throw new Error(`Checkout write restriction could not be prepared: ${resolved.reason ?? failed.join(", ")}`);
  }
  // Keep the admitted sandbox identity: the governed hold and worker callers
  // share it. Re-resolving preserves the private folder qualification token.
  Object.assign(sandbox, { protection: resolved.protection });
}
