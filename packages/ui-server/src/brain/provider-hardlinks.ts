/**
 * Hardlinks out of a turn's masked provider folders (#2700). A folder mask
 * hides names, not inodes: a hardlink is the same file under another name, so
 * a regular file outside the masks that shares a masked file's inode would
 * hand the turn the masked bytes. Admission finds such names and refuses.
 */
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";

export interface ProviderHardlink { readonly path: string; readonly masked: string }

const vanished = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Metadata only; no file is opened. Symbolic links are neither followed nor
 * counted: the worker resolves them in its own namespace, where the target is
 * masked. The root `.git` and `.brain-index` are skipped because a masked turn
 * sees `.git` hidden and `.brain-index` replaced by its private index; every
 * other folder counts, hidden ones and `node_modules` included.
 *
 * Bound: one `lstat` per regular file inside the masked folders, the only
 * cost when no masked file has a name outside them (link count above the
 * names found inside). Otherwise one `lstat` per regular file outside, until
 * every such extra name is found, so at most one pass over the brain.
 */
export function providerHardlinks(root: string, masked: readonly string[]): ProviderHardlink[] {
  const within = (path: string) => masked.some(folder => path === folder || path.startsWith(`${folder}/`));
  const files = (rel: string, skip: (path: string) => boolean, visit: (path: string, info: BigIntStats) => boolean): boolean => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch (error) { if (vanished(error)) return true; throw error; }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(path)) continue;
      if (entry.isDirectory()) { if (!files(path, skip, visit)) return false; continue; }
      if (!entry.isFile()) continue;
      let info: BigIntStats;
      try { info = lstatSync(join(root, path), { bigint: true }); } catch (error) { if (vanished(error)) continue; throw error; }
      if (info.isFile() && info.nlink > 1n && !visit(path, info)) return false;
    }
    return true;
  };
  // Each multiply linked masked inode, with how many of its names are not yet found.
  const linked = new Map<string, { masked: string; unseen: bigint }>();
  const key = (info: BigIntStats) => `${info.dev}:${info.ino}`;
  for (const folder of [...new Set(masked)].sort()) {
    if (masked.some(parent => folder.startsWith(`${parent}/`))) continue;
    // An absent folder hides nothing; a symlinked one the launcher refuses.
    const info = lstatSync(join(root, folder), { throwIfNoEntry: false });
    if (!info?.isDirectory()) continue;
    files(folder, () => false, (path, file) => {
      const seen = linked.get(key(file));
      if (seen) seen.unseen--; else linked.set(key(file), { masked: path, unseen: file.nlink - 1n });
      return true;
    });
  }
  let unseen = 0n;
  for (const entry of linked.values()) if (entry.unseen > 0n) unseen += entry.unseen;
  const found: ProviderHardlink[] = [];
  if (!unseen) return found;
  files("", path => path === ".git" || path === INDEX_DIR || within(path), (path, file) => {
    const entry = linked.get(key(file));
    if (!entry || entry.unseen <= 0n) return true;
    entry.unseen--; unseen--;
    found.push({ path, masked: entry.masked });
    // Every name is accounted for: no further file can share a masked inode.
    return unseen > 0n;
  });
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
