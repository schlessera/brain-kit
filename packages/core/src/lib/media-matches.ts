/**
 * What a `media.track` or `media.ignore` change does to the files sync sees
 * now (#2781, epic #1777, design rev 3 §5.2-§5.4, carried by rev 4 §7): the
 * current matches of the pattern being added or removed, with the class sync
 * gives each one before and after the change. Their digest is the
 * match-inventory digest an approval binds, so a file that starts or stops
 * matching between preview and apply makes the approval stale.
 *
 * Only files `sync assess` reports are matched: committed, unchanged files
 * are not re-classified by a policy change, and git-ignored or protected
 * state (`.brain/`) never reaches sync. Future files are not listed, only
 * named: a pattern with no `/` matches every same-named file in any folder.
 * Reads only.
 */
import { createHash } from "crypto";
import { lstatSync } from "fs";
import { join } from "path";

import { mediaPolicyClass, type MediaPolicy } from "./media.js";
import { assess } from "./sync/assess.js";
import { matchesAnyPattern } from "./tool-leftovers.js";

/** The class a policy gives a file, as far as the lists decide it: null is sync's ordinary rules. */
export type MediaListClass = "TRACK" | "ARTIFACT" | "SENSITIVE" | null;

export interface MediaMatch {
  path: string;
  /** Bytes on disk, or null when the file is gone or unreadable. */
  bytes: number | null;
  before: MediaListClass;
  after: MediaListClass;
}

export interface MediaMatches {
  pattern: string;
  /** A pattern without `/` matches by file name in every folder, now and in future. */
  anyFolder: boolean;
  /** Files sync sees now that the pattern matches. */
  count: number;
  /** Their bytes on disk. */
  bytes: number;
  /** Matches whose class the change alters. */
  changed: number;
  /** Matches an ignore entry still makes `ARTIFACT` after a track change. */
  ignoredStill: number;
  /** Matches with a secret-shaped name: always `SENSITIVE`, never committed. */
  sensitive: number;
  /** The five largest matches, largest first, then by path. */
  largest: MediaMatch[];
  /** SHA-256 over every match, in path order: what an approval binds. */
  digest: string;
}

const LARGEST = 5;

/**
 * The current matches of `pattern` among the files sync sees, classed under
 * `before` and `after`, from a fresh `sync assess` of `root`.
 */
export function mediaMatches(root: string, pattern: string, before: MediaPolicy, after: MediaPolicy): MediaMatches {
  const rows = assess(root, before)
    .filter((f) => f.status !== "D")
    .map((f) => ({ path: f.path, sensitive: f.class === "SENSITIVE" }))
    .filter((f) => matchesAnyPattern(f.path, [pattern]))
    .map((f): MediaMatch => {
      const info = lstatSync(join(root, f.path), { throwIfNoEntry: false });
      const klass = (policy: MediaPolicy): MediaListClass => (f.sensitive ? "SENSITIVE" : mediaPolicyClass(f.path, policy));
      return { path: f.path, bytes: info?.isFile() ? info.size : null, before: klass(before), after: klass(after) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const largest = [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || (a.path < b.path ? -1 : 1)).slice(0, LARGEST);
  return {
    pattern,
    anyFolder: !pattern.includes("/"),
    count: rows.length,
    bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
    changed: rows.filter((r) => r.before !== r.after).length,
    ignoredStill: rows.filter((r) => r.after === "ARTIFACT" && after.track.includes(pattern)).length,
    sensitive: rows.filter((r) => r.before === "SENSITIVE").length,
    largest,
    digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

/**
 * Why `pattern` cannot be a list entry, or null. Patterns are literal except
 * `*`; there is no negation, and an entry is a relative path or a file name.
 */
export function patternRefusal(pattern: string): string | null {
  if (pattern === "" || Buffer.byteLength(pattern) > 4096 || /[\\\u0000-\u001f\u007f]/u.test(pattern)) return "invalid-pattern";
  if (pattern.startsWith("!")) return "not-expressible";
  if (pattern.startsWith("/") || pattern.split("/").some((part) => part === "" || part === "." || part === "..")) return "invalid-pattern";
  return null;
}

/** The scope of a list entry: one exact path (it has a `/` and no `*`), or a rule that can match more (rev 4 §7). */
export function patternScope(pattern: string): "exact" | "pattern" {
  return pattern.includes("/") && !pattern.includes("*") ? "exact" : "pattern";
}
