/** Private whole-fixture effects observer. It never follows a symbolic link. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface Entry {
  kind: "file" | "directory" | "symlink" | "other";
  mode: number;
  mtimeNs: string;
  size: string;
  bytesBase64?: string;
  sha256?: string;
  linkTarget?: string;
}
export type Observation = Record<string, Entry>;
const DISPOSABLE = new Set(["brain.db", "brain.db-wal", "brain.db-shm"]);

/** Only the documented disposable root database is excluded; hidden/binary files participate. */
export function observe(root: string): Observation {
  const entries: Observation = {};
  function walk(relative: string) {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (DISPOSABLE.has(path)) continue;
      const full = join(root, path);
      const stat = lstatSync(full, { bigint: true });
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      const entry: Entry = { kind, mode: Number(stat.mode), mtimeNs: stat.mtimeNs.toString(), size: stat.size.toString() };
      if (kind === "file") {
        const bytes = readFileSync(full);
        entry.bytesBase64 = bytes.toString("base64");
        entry.sha256 = createHash("sha256").update(bytes).digest("hex");
      } else if (kind === "symlink") entry.linkTarget = readlinkSync(full);
      entries[path] = entry;
      if (kind === "directory") walk(path);
    }
  }
  walk("");
  return entries;
}

export function differences(before: Observation, after: Observation) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(path => {
    const a = before[path], b = after[path];
    if (!a || !b) return [{ path, fields: [a ? "removed" : "added"] }];
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter(key => a[key as keyof Entry] !== b[key as keyof Entry]);
    return fields.length ? [{ path, fields }] : [];
  });
}
