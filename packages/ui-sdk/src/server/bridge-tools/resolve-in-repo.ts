import { resolveContainedSync, type ContainmentPolicy } from "@schlessera/brain-common/internal/safe-path";

const SDK_CONTAINMENT: ContainmentPolicy = { missingRoot: "refuse", danglingLinks: "refuse", components: "every" };

/**
 * Resolve a repo-relative path without allowing a symlink to escape the repo.
 *
 * The SDK's row of the shared resolver (`@schlessera/brain-common/internal/safe-path`,
 * #2506), with the strictest answer in every row since #3422, as core's
 * `safeResolve` gives: an absolute request is refused even inside the root,
 * and so is any `..` segment, `:` or `\\` in a segment, a dangling link
 * wherever it points, and a path any existing component of which leaves the
 * root. Synchronous, `null` for every refusal, the canonical path on success.
 */
export function resolveInRepo(root: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.startsWith("/") || relPath.startsWith("\\")) return null;
  if (relPath.split("/").some((segment) => segment === ".." || segment.includes(":") || segment.includes("\\"))) return null;
  const contained = resolveContainedSync(root, relPath, SDK_CONTAINMENT);
  return contained.ok ? contained.canonical : null;
}
