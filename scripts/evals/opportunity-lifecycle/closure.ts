/** Literal owned-tree closure: content, executable modes and resolved link identity. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

type Physical = { kind: "file" | "directory" | "symlink"; mode: number; device: string; inode: string;
  mtimeNs: string; size: string; sha256?: string; literalTarget?: string };
export type ClosureEntry = Physical & { resolvedPath?: string; resolvedIdentity?: Physical; targetClosureSHA256?: string };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function ownedClosure(directory: string): Record<string, ClosureEntry> {
  const root = realpathSync(resolve(directory)), physical: Record<string, Physical> = {};
  const resolvedLinks = new Map<string,string>();
  function walk(path: string) {
    // Git administration is not executable fixture/source/dependency input.
    if (path === ".git") return;
    const full = path === "." ? root : join(root,path), stat = lstatSync(full,{ bigint: true });
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
    if (!kind) throw new Error(`unsupported owned-tree entry: ${path}`);
    const item: Physical = { kind, mode: Number(stat.mode), device: stat.dev.toString(), inode: stat.ino.toString(),
      mtimeNs: stat.mtimeNs.toString(), size: stat.size.toString() };
    physical[path] = item;
    if (kind === "file") item.sha256 = sha(readFileSync(full));
    if (kind === "symlink") {
      item.literalTarget = readlinkSync(full);
      const target = realpathSync(full); // Reject dangling links/cycles; never hash external target bytes.
      if (target !== root && !target.startsWith(root + sep)) throw new Error(`link leaves owned tree: ${path}`);
      const targetPath = relative(root,target).split(sep).join("/") || ".";
      if (targetPath === ".git" || targetPath.startsWith(".git/")) throw new Error(`link enters excluded Git administration: ${path}`);
      resolvedLinks.set(path,targetPath);
    }
    if (kind === "directory") for (const name of readdirSync(full).sort()) walk(path === "." ? name : `${path}/${name}`);
  }
  walk(".");
  const result: Record<string, ClosureEntry> = Object.fromEntries(Object.entries(physical).map(([path,entry]) => [path,{ ...entry }]));
  for (const [path,target] of resolvedLinks) {
    const identity = physical[target];
    if (!identity || identity.kind === "symlink") throw new Error(`resolved target omitted from physical closure: ${path}`);
    const subtree = Object.entries(physical).filter(([entry]) => entry === target || target === "." || entry.startsWith(target + "/"));
    result[path] = { ...physical[path]!, resolvedPath: target, resolvedIdentity: { ...identity }, targetClosureSHA256: sha(JSON.stringify(subtree)) };
  }
  return result;
}

export function closureDigest(entries: Record<string, ClosureEntry>) { return sha(JSON.stringify(entries)); }
