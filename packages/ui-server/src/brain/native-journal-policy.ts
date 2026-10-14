/** Frozen per-turn retention rules over metadata from a sealed native root. */
import ignore, { type Ignore } from "ignore";

type Entry = { path: string; kind: "file" | "symlink" | "directory" | "other"; bytes: number };
type Rule = { directory: string; matcher: Ignore };
const prefix = (path: string, directory: string) => !directory || path.startsWith(`${directory}/`);

/** Git internals are excluded except the existing raw HEAD/refs coverage. */
export function journalPathScope(path: string): { scope: string; local: string; refs: boolean } | null {
  const segments = path.split("/");
  const scope = segments[0] === "workspaces" && segments.length > 1 ? segments.slice(0, 2).join("/") : "";
  const local = scope ? segments.slice(2).join("/") : path;
  const parts = local.split("/");
  const git = parts.indexOf(".git");
  if (git < 0) return { scope, local, refs: false };
  if (git !== 0 || !(parts.length === 2 && ["HEAD", "packed-refs"].includes(parts[1]!) || parts[1] === "refs" && parts.length > 2)) return null;
  return { scope, local, refs: true };
}

export async function freezeNativeJournalPolicy(entries: Iterable<Entry>, read: (path: string, maximum: number) => Promise<Buffer>, covered: readonly string[] = []) {
  const rules = new Map<string, Rule[]>();
  const admitted = new Set(covered);
  // Metadata is already indexed. Only ignore files are read here; no baseline
  // content, object hashes or per-turn content manifest is produced.
  for (const entry of entries) {
    const location = journalPathScope(entry.path);
    if (!location || location.refs) continue;
    if (location.local.split("/").at(-1) !== ".gitignore") continue;
    if (entry.kind !== "file" || entry.bytes > 1024 * 1024) throw new Error("Native journal ignore rules require a bounded regular file.");
    const group = rules.get(location.scope) ?? [];
    group.push({ directory: location.local.includes("/") ? location.local.slice(0, location.local.lastIndexOf("/")) : "", matcher: ignore().add((await read(entry.path, 1024 * 1024)).toString("utf8")) });
    rules.set(location.scope, group);
  }
  for (const group of rules.values()) group.sort((a, b) => a.directory.split("/").length - b.directory.split("/").length || a.directory.localeCompare(b.directory));
  function ignored(path: string): boolean {
    const location = journalPathScope(path);
    if (!location) return true;
    if (location.refs || admitted.has(path)) return false;
    const components = location.local.split("/");
    // A directory ignored by its parent's rules cannot be resurrected by a
    // descendant .gitignore. Evaluate each ancestor before the final file.
    for (let count = 1; count <= components.length; count++) {
      const candidate = components.slice(0, count).join("/");
      let excluded = false;
      for (const rule of rules.get(location.scope) ?? []) {
        if (!prefix(candidate, rule.directory)) continue;
        const relative = rule.directory ? candidate.slice(rule.directory.length + 1) : candidate;
        if (!relative) continue;
        const match = rule.matcher.test(relative + (count < components.length ? "/" : ""));
        if (match.ignored) excluded = true;
        else if (match.unignored) excluded = false;
      }
      if (excluded) return true;
    }
    return false;
  }
  return { ignored, cover(paths: readonly string[]) { for (const path of paths) admitted.add(path); } };
}
