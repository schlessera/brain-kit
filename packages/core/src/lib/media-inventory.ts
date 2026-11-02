/**
 * The one per-file media inventory (#2780, epic #1777). Offline `brain sync`
 * counts it and hygiene review selects from it, through the same functions,
 * so the CLI and the server cannot disagree about which files await a
 * decision.
 *
 * Two populations, and only two:
 * - **Assessment.** The working-tree files `assess` classes MEDIA or LARGE:
 *   not Git-ignored, not matched by `media.ignore` or `media.track`. They are
 *   counted in `Media awaiting review: N`.
 * - **Conversation-pinned scratch.** Paths a conversation linked, read from
 *   the scratch pin snapshot (`.brain/scratch-pins/pins.json`), that are
 *   regular MEDIA or LARGE files under `.brain/scratch/`, even when they match
 *   `media.ignore`. They are review-only: they never change the count. The
 *   scratch directory is never walked, so an unpinned render or draft never
 *   becomes a finding.
 *
 * Ignored files outside scratch stay out, and ignore-over-track precedence is
 * unchanged (`mediaPolicyClass`). Everything here reads; nothing writes, and
 * the pin snapshot in particular is only ever opened read-only.
 */

import { createHash } from "crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "fs";
import { join, resolve } from "path";

import type { HygieneCandidate, HygieneFinding, HygieneSeverity } from "./hygiene.js";
import { resolveEnv } from "../config/env.js";
import { isMediaPath, type MediaPolicy } from "./media.js";
import { readScratchPinSnapshot, SCRATCH_PINS_FILE } from "./scratch.js";
import type { AssessedFile } from "./sync/artifacts.js";
import { assess } from "./sync/assess.js";
import { git } from "./sync/git.js";
import { matchesAnyPattern } from "./tool-leftovers.js";

/** The brain's transient scratch area; generated brains Git-ignore it. */
export const SCRATCH_PREFIX = ".brain/scratch/";
/** The server's snapshot of which conversations link which scratch paths. */
export const PIN_FILE = SCRATCH_PINS_FILE;
/** Distinct pinned paths one inventory reads, unless a trusted host overrides it. */
export const DEFAULT_PINNED_PATH_LIMIT = 5000;
/** The hygiene category every media finding has. */
export const MEDIA_CATEGORY = "media";
/**
 * The fingerprint's reference-inventory digest before the declared reference
 * scan exists. The governed effects (#2781) own that scan and its bounds; until
 * then every media finding records this same value, so no disposition is
 * ever bound to a reference set nobody checked.
 */
export const REFS_UNSCANNED = "unscanned";

/**
 * - `complete`: the snapshot is ready; its sessions are the whole picture.
 * - `incomplete`: a valid snapshot whose scan has not finished (`ready: false`).
 *   Its listed paths are positive evidence and are admitted; more may exist.
 * - `unknown`: missing, unreadable, not a regular file, or malformed. No
 *   scratch path is admitted (`pins-unknown`).
 */
export type PinSnapshotState = "complete" | "incomplete" | "unknown";

export interface ScratchPins {
  state: PinSnapshotState;
  /** Each pinned scratch path this inventory read, with the sorted session keys listing it. */
  sessions: Map<string, string[]>;
  /** Distinct valid scratch paths the snapshot lists. */
  observed: number;
  /** The bound in force: at most this many distinct paths are read. */
  limit: number;
}

/**
 * The pin bound a trusted host set (`BRAIN_MEDIA_PINNED_PATH_LIMIT`), or the
 * default. Anything but a positive integer is refused rather than guessed.
 */
export function pinnedPathLimit(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PINNED_PATH_LIMIT;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error(`BRAIN_MEDIA_PINNED_PATH_LIMIT must be a positive integer, not "${value}"`);
  }
  return Number(value);
}

/**
 * The pin snapshot for the inventory, through the same read-only reader
 * scratch pruning uses (`readScratchPinSnapshot`): a missing, unreadable,
 * redirected or malformed snapshot is `unknown` and admits nothing. At most
 * `limit` distinct paths are kept, in path order; `observed` says how many
 * the snapshot lists.
 */
export function readScratchPins(root: string, limit = DEFAULT_PINNED_PATH_LIMIT): ScratchPins {
  let snapshot: { ready: boolean; sessions: Record<string, string[]> };
  try {
    snapshot = readScratchPinSnapshot(realpathSync(root));
  } catch {
    return { state: "unknown", sessions: new Map(), observed: 0, limit };
  }
  const byPath = new Map<string, Set<string>>();
  for (const [key, paths] of Object.entries(snapshot.sessions)) {
    for (const path of paths) {
      let keys = byPath.get(path);
      if (!keys) byPath.set(path, (keys = new Set()));
      keys.add(key);
    }
  }
  const paths = [...byPath.keys()].sort();
  const sessions = new Map(paths.slice(0, limit).map((path) => [path, [...byPath.get(path)!].sort()] as const));
  return { state: snapshot.ready ? "complete" : "incomplete", sessions, observed: paths.length, limit };
}

export type MediaClass = "MEDIA" | "LARGE";

/** One file awaiting a media decision. Its identity is the exact raw repo-relative path. */
export interface MediaItem {
  path: string;
  /** `content` came from assessment and is counted; `scratch` came only from a conversation pin. */
  source: "content" | "scratch";
  classes: MediaClass[];
  bytes: number;
  /** Hex SHA-256 of the bytes, or `unreadable`. */
  sha256: string;
  /** Matching policy entries: `ignore <pattern>` and `track <pattern>`, sorted. */
  policy: string[];
  /** Sorted session keys whose pin list holds this exact path; empty outside scratch. */
  pins: string[];
}

/** What the inventory says about conversation links, for the notice review shows. */
export interface MediaLinks {
  /** The pin snapshot's state, `unknown` when it could not be read (`pins-unknown`). */
  state: PinSnapshotState;
  /** Distinct pinned scratch paths listed, and the bound in force. */
  observed: number;
  limit: number;
  /** More paths were listed than the bound allows: discovery is not complete (`inventory-too-large`). */
  tooLarge: boolean;
  /** Pinned scratch paths that are symlinks: counted here, never a finding and never acted on. */
  symlinks: number;
}

export interface MediaInventory {
  items: MediaItem[];
  links: MediaLinks;
}

/** Whether a pinned path is a regular file reached through real directories only. */
function pinnedEntry(root: string, path: string): "file" | "symlink" | null {
  const parts = path.split("/");
  let at = root;
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]!);
    let stat;
    try {
      stat = lstatSync(at);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return i === parts.length - 1 ? "symlink" : null;
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return null;
  }
  return "file";
}

/** SHA-256 and size of a regular file, read without following a final link. */
function digest(root: string, path: string): { sha256: string; bytes: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(resolve(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let read: number;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    return { sha256: hash.digest("hex"), bytes: stat.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function classesOf(path: string, bytes: number, policy: MediaPolicy): MediaClass[] {
  const classes: MediaClass[] = [];
  if (isMediaPath(path)) classes.push("MEDIA");
  if (bytes > policy.maxTrackedBytes) classes.push("LARGE");
  return classes;
}

function policyEntries(path: string, policy: MediaPolicy): string[] {
  return [
    ...policy.ignore.filter((p) => matchesAnyPattern(path, [p])).map((p) => `ignore ${p}`),
    ...policy.track.filter((p) => matchesAnyPattern(path, [p])).map((p) => `track ${p}`),
  ].sort();
}

/**
 * The inventory over `assessed` (one `assess` of the working tree) and the
 * pin snapshot. An assessed file is `content` even under scratch (a brain
 * that does not ignore scratch commits it like any other file); a pinned
 * path assessment did not see is `scratch`. Items are in path order.
 */
export function mediaInventory(root: string, policy: MediaPolicy, assessed: readonly AssessedFile[], pins: ScratchPins): MediaInventory {
  const items = new Map<string, MediaItem>();
  for (const file of assessed) {
    if ((file.class !== "MEDIA" && file.class !== "LARGE") || file.status === "D") continue;
    const read = digest(root, file.path);
    const bytes = read?.bytes ?? file.bytes ?? 0;
    const classes = classesOf(file.path, bytes, policy);
    items.set(file.path, {
      path: file.path,
      source: "content",
      classes: classes.length > 0 ? classes : [file.class],
      bytes,
      sha256: read?.sha256 ?? "unreadable",
      policy: policyEntries(file.path, policy),
      pins: pins.state === "unknown" ? [] : pins.sessions.get(file.path) ?? [],
    });
  }
  let symlinks = 0;
  if (pins.state !== "unknown") {
    for (const [path, keys] of pins.sessions) {
      if (items.has(path)) continue;
      const entry = pinnedEntry(root, path);
      if (entry === "symlink") symlinks++;
      if (entry !== "file") continue;
      const read = digest(root, path);
      if (!read) continue;
      const classes = classesOf(path, read.bytes, policy);
      if (classes.length === 0) continue;
      items.set(path, { path, source: "scratch", classes, bytes: read.bytes, sha256: read.sha256, policy: policyEntries(path, policy), pins: keys });
    }
  }
  return {
    items: [...items.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    links: { state: pins.state, observed: pins.observed, limit: pins.limit, tooLarge: pins.observed > pins.limit, symlinks },
  };
}

const SEVERITY: Record<MediaClass, HygieneSeverity> = { MEDIA: "info", LARGE: "warning" };

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The hygiene candidates for the inventory: one per class, all with category
 * `media` and the path as evidence, so MEDIA and LARGE on one file join into
 * one finding with both provenances. MEDIA is informational, LARGE a warning
 * (severity ruling B); no urgency is inferred. A pinned-only source is named
 * `scratch-media`/`scratch-large`, which is how the count tells it apart.
 */
export function mediaCandidates(inventory: MediaInventory): HygieneCandidate[] {
  return inventory.items.flatMap((item) => item.classes.map((klass): HygieneCandidate => ({
    category: MEDIA_CATEGORY,
    path: item.path,
    evidence: item.path,
    message: item.source === "scratch"
      ? `Media linked from ${item.pins.length} conversation${item.pins.length === 1 ? "" : "s"} awaits a decision (${size(item.bytes)})`
      : `Media awaits a decision before it is committed (${size(item.bytes)})`,
    source: { source: "hygiene", name: `${item.source === "scratch" ? "scratch-" : ""}${klass.toLowerCase()}`, severity: SEVERITY[klass] },
    facts: {
      sha256: item.sha256,
      bytes: String(item.bytes),
      classes: item.classes.join(","),
      policy: item.policy.join("\n"),
      refs: REFS_UNSCANNED,
      pins: item.pins.join("\n"),
    },
  })));
}

/** Whether a finding is media the routine count includes: one assessment reported. */
export function countedMedia(finding: Pick<HygieneFinding, "category" | "sources">): boolean {
  return finding.category === MEDIA_CATEGORY && finding.sources.some((s) => s.source === "hygiene" && (s.name === "media" || s.name === "large"));
}

/**
 * The working tree's media assessment and the pin snapshot, as one
 * inventory: what `brain hygiene` detects and what review selects from.
 * Outside a Git work tree there is nothing uncommitted, so assessment adds
 * nothing; a Git failure inside one throws. The pin bound is the trusted
 * host's `BRAIN_MEDIA_PINNED_PATH_LIMIT`, or 5,000.
 */
export function buildMediaInventory(root: string, policy: MediaPolicy): MediaInventory {
  const limit = pinnedPathLimit(resolveEnv().mediaPinnedPathLimit);
  const assessed = git(root, ["rev-parse", "--is-inside-work-tree"]).stdout === "true" ? assess(root, policy) : [];
  return mediaInventory(root, policy, assessed, readScratchPins(root, limit));
}
