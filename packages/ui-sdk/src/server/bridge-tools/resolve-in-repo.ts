import { resolveContainedSync, type ContainmentPolicy } from "@schlessera/brain-common/internal/safe-path";
import { isAbsolute } from "path";

const SDK_CONTAINMENT: ContainmentPolicy = { missingRoot: "refuse", danglingLinks: "follow", components: "final" };

/**
 * Resolve a repo-relative path without allowing a symlink to escape the repo.
 *
 * The SDK's row of the shared resolver (`@schlessera/brain-common/internal/safe-path`,
 * #2506): core's (`safeResolve`), except that an absolute path is refused
 * even when it lies inside the root. Synchronous, `null` for every refusal,
 * the canonical path on success.
 */
export function resolveInRepo(root: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;
  const contained = resolveContainedSync(root, relPath, SDK_CONTAINMENT);
  return contained.ok ? contained.canonical : null;
}
