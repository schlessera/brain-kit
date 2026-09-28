/**
 * What `brain sync assess` sees in the working tree: one class per changed
 * path, and the domain `group` files a tracked path under. Reads git and the
 * filesystem; changes nothing.
 */

import { lstatSync, readFileSync } from "fs";
import { resolve } from "path";

import { isMediaPath, mediaPolicyClass, type MediaPolicy } from "../media.js";
import type { Taxonomy } from "../taxonomy.js";
import { matchesAnyPattern, TOOL_LEFTOVER_PATTERNS } from "../tool-leftovers.js";
import type { AssessedFile } from "./artifacts.js";
import { git } from "./git.js";

export type { AssessedFile } from "./artifacts.js";

// Artifact + sensitive path globs (ported from sync.sh). No personal patterns.
// The tool leftovers are shared with brain doctor and the template .gitignore.
export const ARTIFACT_PATTERNS = [
  ...TOOL_LEFTOVER_PATTERNS,
  // No office formats: a presentation is media, and the MEDIA/LARGE classes
  // (with `media.ignore` for generated ones) decide it.
  "*.pyc", "__pycache__/*", "*.db-shm", "*.db-wal", "tmp/*", "*.log",
];
export const SENSITIVE_PATTERNS = [
  ".env", ".env.*", "credentials*", "*.key", "*.pem", "*.secret", "*_secret*", "*_token*",
];
/**
 * The SENSITIVE patterns a name alone settles. Every other one (`*_token*`,
 * `credentials*`, …) also matches notes (`design_token_ideas.md`), so a file
 * it matches is neither ignored nor committed unattended: someone decides.
 */
export const UNAMBIGUOUS_SENSITIVE_PATTERNS = [".env", ".env.*", "*.key", "*.pem"];
const TRACKABLE_EXTS = new Set([
  "md", "ts", "sh", "js", "json", "yaml", "yml", "toml", "css", "html", "py", "txt",
]);
const CONFIG_FILES = new Set([
  ".gitignore", "CLAUDE.md", "README.md", "AGENTS.md", "package.json", "bun.lock", "bun.lockb", "tsconfig.json",
]);

/**
 * Sidecars that an embeddings index run rewrites (see `saveContextCache` /
 * `saveAssetCache` in lib/indexer). They are derived from brain.db but are
 * committed so fresh clones and rebuilds skip regeneration — which means the
 * reindex at the end of a sync routinely dirties the tree *after* the push.
 * post-sync owns that dirt and commits it itself.
 */
export const DERIVED_CACHES = new Set([".context-cache.jsonl", ".asset-cache.jsonl"]);

/**
 * One record per `git status` entry: the two-character code and the path.
 *
 * `--porcelain=v1 -z` rather than the default: NUL-separated records keep the
 * leading space of an unstaged code (` M path`) that trimming would eat, and
 * paths arrive literal — no quoting, no ` -> ` arrow to re-split, so a path
 * containing either is not mis-parsed. Renames and copies emit the destination
 * first and the original as the following record, which is skipped.
 */
function porcelainRecords(root: string): { xy: string; file: string }[] {
  const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true);
  if (result.code !== 0) throw new Error(`Git status failed: ${result.stderr}`);
  const records = result.stdout.split("\0");
  const entries: { xy: string; file: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i]!;
    if (!line) continue;
    const xy = line.slice(0, 2);
    entries.push({ xy, file: line.slice(3) });
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return entries;
}

function isTrackable(file: string): boolean {
  const ext = file.includes(".") ? file.split(".").pop()! : "";
  if (TRACKABLE_EXTS.has(ext)) return true;
  if (file.startsWith(".claude/skills/") || file.startsWith(".agents/skills/") || file.startsWith("scripts/")) {
    return true;
  }
  return CONFIG_FILES.has(file);
}

/** Domain for a tracked path: special dirs → skills/config, else the doc type. */
export function domainFor(path: string, taxonomy: Taxonomy): string {
  if (path.startsWith(".agents/skills/") || path.startsWith(".claude/skills/") || path.startsWith("scripts/")) {
    return "skills";
  }
  if (CONFIG_FILES.has(path)) return "config";
  return taxonomy.typeForPath(path);
}

/**
 * Size of `file` under `root` as git would store it: a regular file's bytes,
 * or null for a deletion or a symlink (git stores the link, not its target).
 * "unreadable" when the size could not be read, which is never a reason to
 * treat a file as small.
 */
function sizeOf(root: string, file: string): number | null | "unreadable" {
  try {
    const stat = lstatSync(resolve(root, file));
    return stat.isFile() ? stat.size : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
}

/**
 * Classes, first match wins:
 * - SENSITIVE: a secret-shaped name, whatever the media policy says.
 * - `media.ignore` → ARTIFACT, `media.track` → TRACK.
 * - ARTIFACT: tool leftovers and generated output.
 * - DERIVED: the sidecar caches.
 * - LARGE: anything over `media.maxTrackedBytes`. An ARTIFACT or DERIVED
 *   match wins over it: those are never committed, whatever their size.
 * - MEDIA: an image, PDF, audio, video or office file.
 * - UNKNOWN when the size could not be read; otherwise TRACK for text, or UNKNOWN.
 */
export function assess(root: string, media: MediaPolicy): AssessedFile[] {
  const files: AssessedFile[] = [];
  for (const { xy, file } of porcelainRecords(root)) {

    let status: string;
    const trimmed = xy.trim();
    if (xy === "??") status = "?";
    else if (trimmed.startsWith("A")) status = "A";
    else if (trimmed.startsWith("M") || xy === "MM") status = "M";
    else if (trimmed.startsWith("D")) status = "D";
    else if (trimmed.startsWith("R")) status = "R";
    else status = trimmed;

    // Skip already-ignored files silently.
    if (git(root, ["check-ignore", "-q", "--", file]).code === 0) continue;

    let klass: AssessedFile["class"];
    let bytes: number | null = null;
    let size: number | null | "unreadable" = null;
    const policy = mediaPolicyClass(file, media);
    if (matchesAnyPattern(file, SENSITIVE_PATTERNS)) klass = "SENSITIVE";
    else if (policy) klass = policy;
    else if (matchesAnyPattern(file, ARTIFACT_PATTERNS)) klass = "ARTIFACT";
    // Committed on purpose, but post-sync commits them after its reindex —
    // taking them here too would just commit a stale copy and duplicate work.
    else if (DERIVED_CACHES.has(file)) klass = "DERIVED";
    else if ((size = sizeOf(root, file)) === "unreadable") klass = "UNKNOWN";
    else if ((bytes = size) !== null && bytes > media.maxTrackedBytes) klass = "LARGE";
    else if (bytes !== null && isMediaPath(file)) klass = "MEDIA";
    else if (isTrackable(file)) klass = "TRACK";
    else klass = "UNKNOWN";

    files.push(
      klass === "MEDIA" || klass === "LARGE" ? { status, class: klass, path: file, bytes: bytes! } : { status, class: klass, path: file }
    );
  }
  return files;
}

/**
 * Which conflict-marker line `line` is, or null. Git writes a marker as
 * `conflict-marker-size` characters (7 unless an attribute says more), then a
 * space and a label or the line's end: `<`, `|` (diff3's base) and `>` take a
 * label, `=` never does. A CR before the line's end is the file's line
 * ending, not part of the marker.
 */
export function conflictMarkerLine(line: string): "<" | "|" | "=" | ">" | null {
  const m = /^(?:(<{7,}|\|{7,}|>{7,})(?: |$)|(={7,})$)/.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  return m ? ((m[1] ?? m[2])![0] as "<" | "|" | "=" | ">") : null;
}

/**
 * True when `text` holds a conflict-marker block: an opening `<` marker line
 * and a later closing `>` one (`conflictMarkerLine`). A `=======` line alone
 * is a setext heading underline, not a conflict.
 */
export function hasConflictMarkers(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) {
    const kind = conflictMarkerLine(line);
    if (kind === "<") open = true;
    else if (kind === ">" && open) return true;
  }
  return false;
}

/**
 * A `git grep -E` pattern for the lines that can open a conflict block: every
 * line `conflictMarkerLine` calls `<` matches it. It only narrows the
 * candidates; `hasConflictMarkers` decides on the whole text.
 */
export const CONFLICT_OPEN_GREP = "^<{7}";

/** The paths among `paths` whose working-tree file holds a conflict-marker block. */
export function conflictMarked(root: string, paths: string[]): string[] {
  return paths.filter((path) => {
    try {
      const file = resolve(root, path);
      return lstatSync(file).isFile() && hasConflictMarkers(readFileSync(file, "utf-8"));
    } catch {
      return false;
    }
  });
}

export function workingTreeDirt(root: string): string[] {
  return porcelainRecords(root).map((record) => record.file);
}

export interface DirtDisposition {
  /** Derived sidecars post-sync rewrote — safe for it to commit unattended. */
  caches: string[];
  /** Everything else — reported, never auto-committed. */
  other: string[];
}

/**
 * Split post-reindex working-tree dirt into what post-sync may commit itself
 * and what only a human/agent should decide about. Pure so the policy is
 * testable without a git fixture or an API key.
 */
export function classifyPostSyncDirt(dirty: string[]): DirtDisposition {
  const caches: string[] = [];
  const other: string[] = [];
  for (const file of dirty) (DERIVED_CACHES.has(file) ? caches : other).push(file);
  return { caches, other };
}
