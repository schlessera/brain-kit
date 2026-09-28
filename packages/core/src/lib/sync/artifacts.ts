/**
 * What a sync does with the files `assess` classes ARTIFACT or SENSITIVE:
 * ignore them, never delete them. An artifact is ignored by the pattern it
 * matched, because the same leftover comes back; a sensitive file by its own
 * path only, so the line cannot hide a note whose name merely looks like a
 * secret's.
 *
 * Git answers every question about what a line ignores (`check-ignore`); the
 * glob matcher assess uses only proposes lines. A line that would hide a file
 * assess meant to keep visible is never left in place.
 */

import { lstatSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { matchesAnyPattern } from "../tool-leftovers.js";
import { git } from "./git.js";

/** One `brain sync assess` entry, the shape `assess` in lib/sync/assess.ts returns. */
export interface AssessedFile {
  status: string;
  class: "SENSITIVE" | "ARTIFACT" | "DERIVED" | "TRACK" | "MEDIA" | "LARGE" | "UNKNOWN";
  path: string;
  /** Size on disk, for MEDIA and LARGE only. */
  bytes?: number;
}

export type IgnoreReason = "artifact" | "sensitive";

export interface IgnoreAddition {
  /** The `.gitignore` line. */
  line: string;
  reason: IgnoreReason;
  /** The assessed files the line is for. */
  paths: string[];
}

export interface IgnorePlan {
  additions: IgnoreAddition[];
  /** Files git already tracks: ignoring changes nothing for them, so they are only reported. */
  tracked: { path: string; reason: IgnoreReason }[];
  /** Files no `.gitignore` line can name: a line break in the path. */
  unignorable: { path: string; reason: IgnoreReason }[];
  /** Every other untracked file assess listed. No added line may hide one. */
  visible: string[];
}

export type IgnoreCommit =
  | { status: "committed"; sha: string }
  /** `.gitignore` had changes of its own before this run; the commit step takes it with them. */
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface IgnoreResult {
  /** Lines appended to `.gitignore`, in order. */
  added: string[];
  /** Planned lines the file already held. */
  present: string[];
  /** Planned paths git still does not ignore, such as one a nested `.gitignore` re-includes. */
  notIgnored: string[];
  /** Null when nothing was written. */
  commit: IgnoreCommit | null;
  /** Why nothing was written, when the write was refused or undone. */
  refused?: string;
}

const HEADER = "# brain sync";
const COMMIT_MESSAGE = "Ignore generated artifacts and secrets";

/**
 * A `.gitignore` line naming `path` and nothing else: anchored with a leading
 * slash so the same name elsewhere stays visible, with glob characters, a
 * backslash and trailing spaces escaped so git reads them literally. Null for
 * a path with a line break, which no line can hold.
 */
export function exactIgnoreLine(path: string): string | null {
  if (/[\n\r]/.test(path)) return null;
  return "/" + path.replace(/[\\*?[]/g, "\\$&").replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
}

/**
 * A pattern that reads the same as a `.gitignore` line: not a comment, a
 * negation, escaped, or using `?` or `[`, which git reads as wildcards and
 * the assess matcher as themselves.
 */
function usableAsLine(pattern: string): boolean {
  return !/^[#!]|[\\?[]|[\n\r]| $/.test(pattern);
}

/**
 * The lines that ignore the ARTIFACT and SENSITIVE files among `files`. An
 * artifact gets the first of `patterns.artifact` it matches, unless that
 * pattern would also match an untracked file of another class, in which case
 * it gets its exact path like a sensitive file does. Sensitive files are
 * never ignored by pattern, so `patterns.sensitive` is accepted and unused.
 */
export function planIgnores(
  files: AssessedFile[],
  patterns: { artifact: readonly string[]; sensitive?: readonly string[] }
): IgnorePlan {
  const untracked = (file: AssessedFile) => file.status === "?";
  const ignorable = (file: AssessedFile) => file.class === "ARTIFACT" || file.class === "SENSITIVE";
  const visible = files.filter((file) => untracked(file) && !ignorable(file)).map((file) => file.path);
  const additions = new Map<string, IgnoreAddition>();
  const plan: IgnorePlan = { additions: [], tracked: [], unignorable: [], visible };

  for (const file of files.filter(ignorable)) {
    const reason: IgnoreReason = file.class === "SENSITIVE" ? "sensitive" : "artifact";
    if (!untracked(file)) {
      plan.tracked.push({ path: file.path, reason });
      continue;
    }
    let line: string | null = null;
    if (reason === "artifact") {
      const pattern = patterns.artifact.find((p) => matchesAnyPattern(file.path, [p]));
      if (pattern && usableAsLine(pattern) && !visible.some((path) => matchesAnyPattern(path, [pattern]))) {
        line = pattern;
      }
    }
    line ??= exactIgnoreLine(file.path);
    if (line === null) {
      plan.unignorable.push({ path: file.path, reason });
      continue;
    }
    const entry = additions.get(line);
    if (entry) entry.paths.push(file.path);
    else additions.set(line, { line, reason, paths: [file.path] });
  }
  plan.additions = [...additions.values()];
  return plan;
}

/**
 * `text` with `lines` appended under the `# brain sync` header, in the
 * file's own line ending. A file that already ends in a `# brain sync` block
 * has it continued; otherwise a new block opens after a blank line. A file
 * without a final line ending still has none.
 */
export function appendIgnoreLines(text: string, lines: string[]): string {
  if (lines.length === 0) return text;
  if (text === "") return [HEADER, ...lines].join("\n") + "\n";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const terminated = text.endsWith("\n");
  const existing = text.split(/\r?\n/);
  if (terminated) existing.pop();
  const lastBlank = existing.findLastIndex((line) => line.trim() === "");
  const endsInOurBlock = lastBlank < existing.length - 1 && existing[lastBlank + 1] === HEADER;
  const endsBlank = existing.length > 0 && existing[existing.length - 1]!.trim() === "";
  const opening = endsInOurBlock ? [] : endsBlank ? [HEADER] : ["", HEADER];
  return (terminated ? text : text + eol) + [...opening, ...lines].join(eol) + (terminated ? eol : "");
}

/** Decoded without dropping a leading U+FEFF, which in a path is part of the name. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Which of `paths` git ignores, by the rules alone (`--no-index`, so tracked files are asked too). Null when git fails. */
function ignoredBy(root: string, paths: string[]): Set<string> | null {
  if (paths.length === 0) return new Set();
  const proc = Bun.spawnSync(["git", "-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
    stdin: new TextEncoder().encode(paths.map((path) => `${path}\0`).join("")),
  });
  // 1 is "none of them ignored"; anything else but 0 is a failure.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) return null;
  return new Set(decoder.decode(proc.stdout).split("\0").filter(Boolean));
}

/**
 * Append the plan's missing lines to the root `.gitignore`, check with git
 * that they ignore what they are for and hide nothing else, and commit
 * `.gitignore` alone. Deletes no file of anyone's, stages nothing but
 * `.gitignore`, and leaves anything else already staged out of the commit.
 *
 * A write that would hide one of the plan's visible files is undone and
 * reported as refused. When `.gitignore` already had uncommitted changes, the
 * lines stay written but are not committed here: the commit would carry
 * someone else's edits under this message.
 */
export function applyIgnores(root: string, plan: IgnorePlan): IgnoreResult {
  const result: IgnoreResult = { added: [], present: [], notIgnored: [], commit: null };
  if (plan.additions.length === 0) return result;
  const file = resolve(root, ".gitignore");
  let before: string | null = null;
  try {
    if (!lstatSync(file).isFile()) return { ...result, refused: ".gitignore is not a regular file" };
    before = readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ...result, refused: `.gitignore unreadable: ${(e as Error).message}` };
  }
  const existing = new Set((before ?? "").split(/\r?\n/));
  for (const { line } of plan.additions) (existing.has(line) ? result.present : result.added).push(line);
  const dirtyBefore = git(root, ["status", "--porcelain", "-z", "--", ".gitignore"], true).stdout !== "";

  if (result.added.length > 0) {
    writeFileSync(file, appendIgnoreLines(before ?? "", result.added), "utf-8");
    const hidden = ignoredBy(root, plan.visible);
    if (hidden === null || hidden.size > 0) {
      // Put the file back as it was; one this call created is removed again.
      if (before === null) rmSync(file, { force: true });
      else writeFileSync(file, before, "utf-8");
      const reason = hidden === null ? "git check-ignore failed" : `the lines would hide ${[...hidden].join(", ")}`;
      return { added: [], present: result.present, notIgnored: [], commit: null, refused: reason };
    }
  }

  const planned = plan.additions.flatMap((addition) => addition.paths);
  const ignored = ignoredBy(root, planned);
  result.notIgnored = planned.filter((path) => !ignored?.has(path));
  if (result.added.length === 0) return result;

  if (dirtyBefore) {
    result.commit = { status: "skipped", reason: ".gitignore had uncommitted changes; commit it with them" };
    return result;
  }
  // `--only` needs a path the index knows; a `.gitignore` this call created is added first.
  const known = git(root, ["ls-files", "-z", "--", ".gitignore"], true).stdout !== "";
  if (!known) {
    const added = git(root, ["add", "--", ".gitignore"]);
    if (added.code !== 0) {
      result.commit = { status: "failed", reason: added.stderr || added.stdout };
      return result;
    }
  }
  const committed = git(root, ["commit", "--only", "-m", COMMIT_MESSAGE, "--", ".gitignore"]);
  if (committed.code !== 0) {
    // Leave the index as it was: a new `.gitignore` goes back to untracked.
    if (!known) git(root, ["rm", "--cached", "-q", "--", ".gitignore"]);
    result.commit = { status: "failed", reason: committed.stderr || committed.stdout };
    return result;
  }
  result.commit = { status: "committed", sha: git(root, ["rev-parse", "HEAD"]).stdout };
  return result;
}
