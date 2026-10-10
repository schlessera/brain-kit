/** Complete fixture filesystem observation; no extension or production writer. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface FileState {
  kind: "file" | "directory" | "symlink" | "other";
  size: string; mode: string; mtimeNs: string | null; sha: string | null; text: string | null; linkTarget: string | null;
}
export type Filesystem = Record<string, FileState>;
export const hygienePaths = ["open.md", "snoozed.md", "dismissed.md", "resolved.md", "_index.md", "last-run.md"].map(p => `context/hygiene/${p}`);
export function snapshot(root: string): Filesystem {
  const files: Filesystem = {};
  function visit(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const rel = path ? `${path}/${name}` : name, full = join(root, rel), stat = lstatSync(full, { bigint: true });
      const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
      const bytes = kind === "file" ? readFileSync(full) : null;
      const decoded = bytes ? bytes.toString("utf8") : null;
      files[rel] = { kind, size: stat.size.toString(), mode: stat.mode.toString(), mtimeNs: kind === "directory" ? null : stat.mtimeNs.toString(),
        sha: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
        text: bytes && Buffer.from(decoded!, "utf8").equals(bytes) ? decoded : null,
        linkTarget: kind === "symlink" ? readlinkSync(full) : null };
      if (kind === "directory") visit(rel);
    }
  }
  visit(""); return files;
}
export function changed(before: Filesystem, after: Filesystem): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path]));
}
export function assertInspectionUnchanged(before: Filesystem, after: Filesystem) {
  const effects = changed(before, after);
  if (effects.length) throw Error(`Unexpected inspection effects: ${effects.join(", ")}`);
}
export function assertReconciliationEffects(before: Filesystem, after: Filesystem) {
  const dirs = new Set(["context", "context/hygiene"]);
  const effects = changed(before, after).filter(path => !hygienePaths.includes(path) && !(dirs.has(path) && after[path]?.kind === "directory"));
  if (effects.length) throw Error(`Unexpected reconciliation effects: ${effects.join(", ")}`);
  for (const path of hygienePaths) if (after[path] && after[path]!.kind !== "file") throw Error(`Non-regular hygiene destination: ${path}`);
}
export function assertRegularInputs(files: Filesystem) {
  if (Object.values(files).some(f => f.kind === "symlink" || f.kind === "other")) throw Error("Fixture source contains symlink or special file");
}
