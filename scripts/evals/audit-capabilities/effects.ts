/** Private complete source observer. SQLite cache bytes are disposable. */
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type SourceEntry = { kind: "file" | "directory" | "symlink" | "other"; mode: number; mtimeNs: string; bytes?: string; target?: string };
export type SourceSnapshot = Record<string, SourceEntry>;
const disposable = new Set(["brain.db", "brain.db-wal", "brain.db-shm"]);
export function sourceSnapshot(root: string): SourceSnapshot {
  const result: SourceSnapshot = {};
  function walk(path: string) {
    const full = path ? join(root, path) : root;
    const stat = lstatSync(full, { bigint: true });
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    // Never exempt a symlink or special file masquerading as disposable SQL.
    if (disposable.has(path) && kind === "file") return;
    result[path] = { kind, mode: Number(stat.mode), mtimeNs: String(stat.mtimeNs),
      ...(kind === "file" ? { bytes: readFileSync(full).toString("base64") } : {}),
      ...(kind === "symlink" ? { target: readlinkSync(full) } : {}),
    };
    if (kind === "directory") for (const entry of readdirSync(full).sort()) walk(path ? `${path}/${entry}` : entry);
  }
  walk("");
  return result;
}
export function sourceTextMap(snapshot: SourceSnapshot): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshot).filter(([, entry]) => entry.kind === "file")
    .map(([path, entry]) => [path, Buffer.from(entry.bytes!, "base64").toString("utf8")]));
}
/** Only exact authored content changes authorize a timestamp change. */
export function assertSourceEffect(before: SourceSnapshot, after: SourceSnapshot, expected: Record<string, string>): void {
  const files = Object.entries(after).filter(([, entry]) => entry.kind === "file");
  if (!isDeepStrictEqual(files.map(([path]) => path).sort(), Object.keys(expected).sort())) throw Error("Unexpected source file membership");
  const changed = new Set<string>();
  for (const [path, entry] of files) {
    if (entry.bytes !== Buffer.from(expected[path]!).toString("base64")) throw Error(`Unexpected source bytes: ${path}`);
    if (before[path]?.bytes !== entry.bytes) changed.add(path);
  }
  const permittedDirectories = new Set<string>();
  for (const path of changed) for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) permittedDirectories.add(parent);
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of allPaths) {
    const old = before[path], current = after[path];
    if (!old || !current || old.kind !== current.kind || old.mode !== current.mode || current.kind === "symlink" || current.kind === "other") throw Error(`Unexpected source member/type/mode: ${path}`);
    // Root directory times also reflect ignored disposable SQLite creation.
    const permittedTime = changed.has(path) || (current.kind === "directory" && (!path || permittedDirectories.has(path)));
    if (!permittedTime && old.mtimeNs !== current.mtimeNs) throw Error(`Unexpected source timestamp: ${path}`);
  }
}
