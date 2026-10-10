/** Private complete filesystem veto around the existing experimental writer. */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { apply, type LifecyclePlan } from "./prototype";
import { digest } from "./source-admission";
export function observe(root: string) {
  const entries: Record<string, { kind: string; mode: number; mtimeNs: string; bytes?: string; target?: string }> = {};
  const rootReal = realpathSync(root);
  function visit(path: string) {
    const full = join(root, path), stat = lstatSync(full, { bigint: true });
    const meta = { mode: Number(stat.mode & 0o7777n), mtimeNs: stat.mtimeNs.toString() };
    if (stat.isSymbolicLink()) {
      const rel = relative(rootReal, realpathSync(full));
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) throw Error("Outside fixture symlink refused");
      entries[path] = { ...meta, kind: "symlink", target: readlinkSync(full) };
    } else if (stat.isDirectory()) {
      entries[path] = { ...meta, kind: "directory" };
      for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    } else if (stat.isFile()) entries[path] = { ...meta, kind: "file", bytes: readFileSync(full).toString("base64") };
    else throw Error("Unsupported fixture entry");
  }
  for (const name of readdirSync(root).sort()) visit(name);
  return entries;
}
export function captureGuard(root: string) { return digest(JSON.stringify(observe(root))); }
export function guardedApply(root: string, plan: LifecyclePlan, expectedSha: string, dryRun = false) {
  if (captureGuard(root) !== expectedSha) throw Error("Complete fixture changed before application");
  return apply(root, plan, dryRun);
}
