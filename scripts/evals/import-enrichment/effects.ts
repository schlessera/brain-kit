/** Full tree/effect and immutable source bytes; not a production multi-writer durability claim. */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { hash, FIELDS, CACHE, MANIFEST, type Settings } from "./prototype";
export function observe(root: string): Record<string, { kind: string; mode: number; mtimeNs: string; bytes: string | null }> {
  const out: ReturnType<typeof observe> = {};
  function visit(path: string, rel: string) {
    const s = lstatSync(path, { bigint: true });
    out[rel] = { kind: s.isDirectory() ? "directory" : s.isSymbolicLink() ? "link" : s.isFile() ? "file" : "unsupported", mode: Number(s.mode), mtimeNs: String(s.mtimeNs), bytes: s.isFile() ? hash(readFileSync(path).toString("base64")) : s.isSymbolicLink() ? readlinkSync(path) : null };
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), rel ? `${rel}/${name}` : name);
    else if (!s.isFile() && !s.isSymbolicLink()) throw Error("Unsupported fixture member");
  }
  for (const name of readdirSync(root).sort()) visit(join(root, name), name);
  return out;
}
function split(raw: string) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/); if (!m) throw Error("Unsupported stamped source");
  return { header: m[1]!, body: raw.slice(m[0].length) };
}
export function assertPreservation(before: string, after: string, mutable: string[]) {
  if (mutable.some(f => !FIELDS.includes(f as typeof FIELDS[number]))) throw Error("Unsupported mutable field");
  const a = split(before), b = split(after);
  if (a.body !== b.body) throw Error("Imported body bytes changed");
  const approved = new Set([...mutable, ...(before !== after ? ["updated"] : [])]);
  const protectedLines = (header: string) => header.split(/(?<=\n)/).filter(line => !approved.has(line.match(/^([A-Za-z_][\w-]*):/)?.[1] ?? "")).join("");
  if (protectedLines(a.header) !== protectedLines(b.header)) throw Error("Unapproved frontmatter bytes/key membership changed");
  if (before.includes("\r\n") !== after.includes("\r\n")) throw Error("Imported line-ending convention changed");
}
export function assertEffects(before: ReturnType<typeof observe>, after: ReturnType<typeof observe>, settings: Settings, written: string[]) {
  const allowed = new Set([...written, CACHE, MANIFEST]);
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[path]) === JSON.stringify(after[path])) continue;
    // Atomic replacement changes the immediate parent clock; only that clock may differ.
    if (written.some(file => file.slice(0, file.lastIndexOf("/")) === path) && before[path]?.kind === "directory" && after[path]?.kind === "directory" && before[path]!.mode === after[path]!.mode && before[path]!.bytes === after[path]!.bytes) continue;
    if (!allowed.has(path)) throw Error(`Unexpected whole import effect: ${path}`);
    if (before[path]?.kind === "link" || after[path]?.kind === "link" || after[path]?.kind !== "file") throw Error("Approved import effect was not a regular file");
    if (before[path] && before[path]!.mode !== after[path]!.mode) throw Error("Import changed file mode");
  }
  if (written.some(path => !settings.files.some(f => f.path === path))) throw Error("Write outside approved input paths");
}
