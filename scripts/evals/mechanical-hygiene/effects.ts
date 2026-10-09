/** Compare full observed effects with exact, independently reviewed file expectations. */
import type { TreeEvidence } from "./observer";
import { treeChanges } from "./observer";

export type ApprovedFile = { bytesBase64: string; mode: number; changed: boolean };
export type EffectApproval = Record<string, ApprovedFile>;

export function assessEffects(before: TreeEvidence, after: TreeEvidence, expected: EffectApproval) {
  const problems: string[] = [];
  const changes = treeChanges(before, after);
  for (const [path, file] of Object.entries(after)) {
    if (file.kind === "directory") {
      if (expected[path]) problems.push(`wrong bytes, kind or mode: ${path}`);
      if (before[path]?.kind === "directory" && before[path].mode !== file.mode)
        problems.push(`directory permission churn: ${path}`);
      continue;
    }
    const approved = expected[path];
    if (!approved) { problems.push(`unapproved file: ${path}`); continue; }
    if (file.kind !== "file" || file.bytesBase64 !== approved.bytesBase64 || file.mode !== approved.mode)
      problems.push(`wrong bytes, kind or mode: ${path}`);
    if (!approved.changed && before[path] && file.mtimeMs !== before[path].mtimeMs)
      problems.push(`unchanged-file timestamp churn: ${path}`);
  }
  for (const path of Object.keys(expected)) if (!after[path]) problems.push(`missing expected file: ${path}`);
  for (const path of changes.deleted) problems.push(`deleted entry: ${path}`);
  // Every new directory must contain a specifically approved file. Empty
  // unexpected directories and symlinks cannot disappear behind a log prefix.
  for (const path of changes.created) if (after[path].kind === "directory" &&
    !Object.keys(expected).some(file => file.startsWith(`${path}/`))) problems.push(`unapproved directory: ${path}`);
  return { accepted: problems.length === 0, problems, changes };
}

export function unchangedApproval(before: TreeEvidence): EffectApproval {
  return Object.fromEntries(Object.entries(before).filter(([, f]) => f.kind === "file").map(([p, f]) =>
    [p, { bytesBase64: f.bytesBase64!, mode: f.mode, changed: false }]));
}
