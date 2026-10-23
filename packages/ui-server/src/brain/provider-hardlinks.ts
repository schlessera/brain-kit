/**
 * Hardlinks out of a turn's masked provider folders (#2700). A folder mask
 * hides names, not inodes: a hardlink is the same file under another name, so
 * a regular file outside the masks that shares a masked file's inode would
 * hand the turn the masked bytes. Admission finds such names and refuses.
 */
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";

export interface ProviderHardlink { readonly path: string; readonly masked: string }

const SLASH = Buffer.from("/");
const vanished = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const under = (path: Buffer, folder: Buffer) => path.equals(folder)
  || (path.length > folder.length && path[folder.length] === SLASH[0] && path.subarray(0, folder.length).equals(folder));

/**
 * Metadata only; no file is opened. Names stay raw bytes, so a name that is
 * not valid UTF-8 is inspected under the name the worker sees. Every entry is
 * `lstat`ed rather than trusted to its directory-entry type, which some
 * filesystems leave unknown. Symbolic links are neither followed nor counted:
 * the worker resolves them in its own namespace, where the target is masked.
 * The root `.git` and `.brain-index` are skipped because a masked turn sees
 * `.git` hidden and `.brain-index` replaced by its private index; every other
 * folder counts, hidden ones, nested `.git` and `node_modules` included.
 *
 * Bound: one `lstat` per entry inside the masked folders, each directory once
 * by identity. That is the only cost when no masked file has a name outside
 * them (link count above the names found inside). Otherwise one `lstat` per
 * entry outside, until every such extra name is found, so at most one pass
 * over the brain.
 */
export function providerHardlinks(root: string, masked: readonly string[]): ProviderHardlink[] {
  const base = Buffer.from(root);
  const folders = [...new Set(masked)].sort().map(folder => Buffer.from(folder));
  const at = (rel: Buffer) => rel.length ? Buffer.concat([base, SLASH, rel]) : base;
  const stat = (rel: Buffer) => { try { return lstatSync(at(rel), { bigint: true }); } catch (error) { if (vanished(error)) return undefined; throw error; } };
  const key = (info: BigIntStats) => `${info.dev}:${info.ino}`;
  const files = (rel: Buffer, skip: (path: Buffer) => boolean, enter: (info: BigIntStats) => boolean,
    visit: (path: Buffer, info: BigIntStats) => boolean): boolean => {
    let names: Buffer[];
    try { names = readdirSync(at(rel), { encoding: "buffer" }); } catch (error) { if (vanished(error)) return true; throw error; }
    for (const name of names) {
      const path = rel.length ? Buffer.concat([rel, SLASH, name]) : name;
      if (skip(path)) continue;
      const info = stat(path);
      if (info?.isDirectory()) { if (enter(info) && !files(path, skip, enter, visit)) return false; }
      else if (info?.isFile() && info.nlink > 1n && !visit(path, info)) return false;
    }
    return true;
  };
  // Each multiply linked masked inode, with how many of its names are not yet
  // found. A directory reached twice (one mask inside another, or through a
  // symlinked parent) is walked once, so no name is counted twice.
  const linked = new Map<string, { masked: string; unseen: bigint }>();
  const walked = new Set<string>();
  const enter = (info: BigIntStats) => !walked.has(key(info)) && Boolean(walked.add(key(info)));
  for (const folder of folders) {
    // An absent folder hides nothing; a symlinked one the launcher refuses.
    const info = stat(folder);
    if (!info?.isDirectory() || !enter(info)) continue;
    files(folder, () => false, enter, (path, file) => {
      const seen = linked.get(key(file));
      if (seen) seen.unseen--; else linked.set(key(file), { masked: path.toString(), unseen: file.nlink - 1n });
      return true;
    });
  }
  let unseen = 0n;
  for (const entry of linked.values()) if (entry.unseen > 0n) unseen += entry.unseen;
  const found: ProviderHardlink[] = [];
  if (!unseen) return found;
  const skipped = [Buffer.from(".git"), Buffer.from(INDEX_DIR)];
  files(Buffer.alloc(0), path => skipped.some(name => path.equals(name)) || folders.some(folder => under(path, folder)), () => true, (path, file) => {
    const entry = linked.get(key(file));
    if (!entry || entry.unseen <= 0n) return true;
    entry.unseen--; unseen--;
    found.push({ path: path.toString(), masked: entry.masked });
    // Every name is accounted for: no further file can share a masked inode.
    return unseen > 0n;
  });
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
