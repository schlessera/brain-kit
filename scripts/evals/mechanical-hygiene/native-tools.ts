/** Tool boundary for private native measurements; the whole process is isolated too. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Phase } from "./collector";
export interface ToolObservation { name: string; input: unknown; allowed: boolean; reason: string }
export function toolVerdict(root: string, phase: Phase, name: string, input: Record<string, unknown>) {
  root = realpathSync(root);
  const inside = (value: unknown) => {
    if (typeof value !== "string" || !value) return null;
    const path = resolve(root, value), rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) return null;
    }
    return rel.replaceAll(sep, "/");
  };
  if (name === "Read") return inside(input.file_path) !== null;
  if (name === "Glob" || name === "Grep") {
    const pattern = input.pattern;
    return inside(input.path ?? root) !== null && !(name === "Glob" && typeof pattern === "string" && (isAbsolute(pattern) || pattern.split("/").includes("..")));
  }
  if (name === "Write" || name === "Edit") {
    const path = inside(input.file_path); if (path === null) return false;
    if (path === ".brain/scratch/hygiene-extra.json") return name === "Write";
    if (path === ".brain/scratch/hygiene-fixed.json") return name === "Write" && phase !== "dry-run";
    return phase !== "dry-run" && path.endsWith(".md") && !path.split("/").some(part => part.startsWith(".")) && !["AGENTS.md", "CLAUDE.md"].includes(path) && !path.startsWith("context/hygiene/");
  }
  if (name === "Bash") {
    // Exact simple spellings avoid shell operators, expansions, alternate roots,
    // arbitrary filenames or a second command. Denials stay in the outcome.
    const command = input.command;
    if (typeof command !== "string") return false;
    const stat = /^stat -c %y (?:"([^"$`\\]+)"|'([^'$`\\]+)'|([^\s$`;&|<>]+))$/.exec(command);
    if (stat) return inside(stat[1] ?? stat[2] ?? stat[3]) !== null;
    if (["brain config check", "brain hygiene list --json", "brain hygiene reconcile --dry-run --json"].includes(command)) return true;
    return command === (phase === "dry-run"
      ? "brain hygiene reconcile --extra .brain/scratch/hygiene-extra.json --dry-run --json"
      : "brain hygiene reconcile --extra .brain/scratch/hygiene-extra.json --fixed .brain/scratch/hygiene-fixed.json --json");
  }
  if (name === "Skill") return input.skill === "content-hygiene";
  return name === "TodoWrite";
}
