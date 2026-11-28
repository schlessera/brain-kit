/**
 * A proof run's directory is projected at /proof, and the read-only
 * repository at /repo holds the same directory a second time when the run
 * lives under the checkout's tmp/. Launch qualification refuses that alias
 * of the run's private state (#4301), so the repository copy is masked.
 */
import { dirname, isAbsolute, relative } from "node:path";

export function repoArtifactMask(root: string, artifact: string): string[] {
  const rel = relative(root, dirname(artifact));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? ["--mount", `type=tmpfs,destination=/repo/${rel},tmpfs-mode=0555`] : [];
}
