/** Whole-tree evidence for the private #842 comparison; never follows symlinks. */
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type FileEvidence = {
  kind: "file" | "directory" | "symlink" | "other";
  mode: number;
  mtimeMs: number;
  bytesBase64?: string;
  target?: string;
};
export type TreeEvidence = Record<string, FileEvidence>;

/** Call only after the owned writer has exited; record every entry, including logs. */
export function observeTree(root: string): TreeEvidence {
  const result: TreeEvidence = {};
  function visit(relative: string) {
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    const common = { mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) {
      result[relative] = { ...common, kind: "symlink", target: readlinkSync(absolute) };
    } else if (stat.isDirectory()) {
      result[relative] = { ...common, kind: "directory" };
      for (const name of readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      result[relative] = { ...common, kind: "file", bytesBase64: readFileSync(absolute).toString("base64") };
    } else {
      result[relative] = { ...common, kind: "other" };
    }
  }
  for (const name of readdirSync(root).sort()) visit(name);
  return result;
}

export function treeChanges(before: TreeEvidence, after: TreeEvidence) {
  const created: string[] = [], deleted: string[] = [], content: string[] = [], metadata: string[] = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[path], b = after[path];
    if (!a) { created.push(path); continue; }
    if (!b) { deleted.push(path); continue; }
    if (a.kind !== b.kind || a.bytesBase64 !== b.bytesBase64 || a.target !== b.target) content.push(path);
    if (a.mode !== b.mode || a.mtimeMs !== b.mtimeMs) metadata.push(path);
  }
  return { created, deleted, content, metadata };
}
