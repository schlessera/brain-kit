/**
 * What a sync does with the stash. An entry whose every change the working
 * tree already holds is dropped, whoever made it; an autostash that applies
 * cleanly to paths nobody has touched is popped; anything else is kept, with
 * the reason. Nothing here clears the stash, resets, or overwrites a file:
 * a pop happens only where `git apply --check` says it applies and none of
 * its paths has local changes.
 *
 * "Holds" is judged per path against the working tree, never the index, and
 * errs toward keeping: an entry is dropped only when the tree has the stash's
 * version of each path, or its change in the same context (see `unheld`).
 */

import { lstatSync, readFileSync, readlinkSync, type Stats } from "fs";
import { resolve } from "path";

import { git, unmergedPaths } from "./git.js";
import { pendingState } from "./merge-state.js";

export interface StashEntry {
  /** The entry's ref when the run started, e.g. `stash@{2}`. Later entries shift down as earlier ones go. */
  ref: string;
  /** The stash commit, which `git stash store <sha>` can bring back after a drop. */
  sha: string;
  /** The reflog subject: `autostash`, `WIP on main: …`, `On main: <message>`. */
  message: string;
}

export interface StashReport {
  dropped: (StashEntry & { reason: string })[];
  popped: StashEntry[];
  kept: (StashEntry & { reason: string })[];
}

/** The subject git gives the entry it saves when an autostash cannot be re-applied (`git stash store -m autostash`). */
const AUTOSTASH = "autostash";

/** The sidecars lib/sync/assess.ts treats as derived (`DERIVED_CACHES` there): merged by key, not by line. */
const DERIVED_CACHES = new Set([".context-cache.jsonl", ".asset-cache.jsonl"]);

/** One side of a path in a stash: its tree entry. */
interface Blob {
  mode: string;
  oid: string;
}

/**
 * A path the stash changes: as the stash's base had it, and as the stash has
 * it (null: absent), with the two commits whose trees differ there.
 */
interface Claim {
  path: string;
  from: string;
  to: string;
  base: Blob | null;
  version: Blob | null;
}

/**
 * Why no entry may be touched now, or null: unmerged paths, or an operation
 * that owns the index and working tree (a merge, a squash with something
 * staged, a rebase, cherry-pick, revert or am, as `pendingState` reads them).
 * A stash leftover is not one: judging its resolution is what this is for.
 */
function blocker(root: string): string | null {
  if (unmergedPaths(root).length > 0) return "the index has unmerged paths";
  const pending = pendingState(root);
  if (pending.kind === "blocked") return `a ${pending.blocker} is in progress`;
  if (pending.kind === "merge" || pending.kind === "squash") return `a ${pending.kind} is in progress`;
  return null;
}

/** The stash, newest first. `%gs` is the reflog subject, one line by construction. */
function listStashes(root: string): StashEntry[] {
  const listed = git(root, ["stash", "list", "-z", "--format=%H%x00%gs"], true);
  if (listed.code !== 0) return [];
  const fields = listed.stdout.split("\0");
  const entries: StashEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    entries.push({ ref: `stash@{${entries.length}}`, sha: fields[i]!, message: fields[i + 1]! });
  }
  return entries;
}

const NO_ENTRY = "000000";

/** What `diff-tree` says changed from `from` to `to`, by path. Null when git cannot say. */
function treeChanges(root: string, from: string, to: string): Map<string, Claim> | null {
  const out = git(root, ["diff-tree", "-r", "-z", "--no-renames", from, to], true);
  if (out.code !== 0) return null;
  const fields = out.stdout.split("\0");
  const changes = new Map<string, Claim>();
  // `:<mode> <mode> <oid> <oid> <status>`, then the path, each NUL-terminated.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(fields[i]!);
    if (!m) return null;
    const path = fields[i + 1]!;
    changes.set(path, {
      path,
      from,
      to,
      base: m[1] === NO_ENTRY ? null : { mode: m[1]!, oid: m[3]! },
      version: m[2] === NO_ENTRY ? null : { mode: m[2]!, oid: m[4]! },
    });
  }
  return changes;
}

/**
 * Every version of a path the entry would bring back: its working-tree state
 * against its base (`<sha>^1`), its index state (`<sha>^2`) where that says
 * something else, and its untracked files (`<sha>^3`, absent from the base).
 * Null for an entry without the shape `git stash` gives one.
 */
function claimsOf(root: string, sha: string): Claim[] | null {
  const worktree = treeChanges(root, `${sha}^1`, sha);
  const index = treeChanges(root, `${sha}^1`, `${sha}^2`);
  if (worktree === null || index === null) return null;
  const claims = [...worktree.values()];
  for (const staged of index.values()) {
    const shown = worktree.get(staged.path)?.version ?? null;
    if (staged.version?.oid !== shown?.oid || staged.version?.mode !== shown?.mode) claims.push(staged);
  }
  if (git(root, ["rev-parse", "-q", "--verify", `${sha}^3`]).code === 0) {
    const listed = git(root, ["ls-tree", "-r", "-z", `${sha}^3`], true);
    if (listed.code !== 0) return null;
    for (const record of listed.stdout.split("\0").filter(Boolean)) {
      const m = /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!m) return null;
      claims.push({ path: m[3]!, from: `${sha}^1`, to: `${sha}^3`, base: null, version: { mode: m[1]!, oid: m[2]! } });
    }
  }
  return claims;
}

/** Text only when it is valid UTF-8 without a NUL; anything else is compared by hash alone. */
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function textOf(bytes: Uint8Array | null): string | null {
  if (bytes === null || bytes.includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/** A blob as the working tree would have it: through the path's smudge and line-ending filters. */
function blobBytes(root: string, blob: Blob, path: string): Uint8Array | null {
  const proc = Bun.spawnSync(["git", "-C", root, "cat-file", "--filters", `--path=${path}`, blob.oid]);
  return proc.exitCode === 0 ? proc.stdout : null;
}

const CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?: |$)|^={7}$/;

function markerLines(text: string): number {
  return text.split("\n").filter((line) => CONFLICT_MARKER.test(line)).length;
}

/**
 * Whether the stash's change to this path is in the working file in its
 * context: its diff reverses cleanly there (`git apply --reverse --check`),
 * so every hunk's result, with the lines around it, is in the file. A line
 * count would call a reordered or moved line held while the file still has
 * it where it was. Fixed context and prefixes, and no external diff, textconv
 * or whitespace leniency: a user's config must not change what is compared.
 */
function changeInContext(root: string, claim: Claim): boolean {
  const patch = Bun.spawnSync([
    "git", "-C", root, "-c", "diff.suppressBlankEmpty=false", "--literal-pathspecs", "diff",
    "-U3", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative",
    "--src-prefix=a/", "--dst-prefix=b/", claim.from, claim.to, "--", claim.path,
  ]);
  if (patch.exitCode !== 0 || patch.stdout.length === 0) return false;
  const check = Bun.spawnSync(
    ["git", "-C", root, "-c", "apply.ignoreWhitespace=false", "apply", "--reverse", "--check", "--whitespace=nowarn"],
    { stdin: patch.stdout }
  );
  return check.exitCode === 0;
}

function cacheKey(line: string): string | null {
  try {
    const { k } = JSON.parse(line) as { k?: unknown };
    return typeof k === "string" && k ? k : null;
  } catch {
    return null;
  }
}

/** Whether the current cache has every key the stashed one has; a line without a key must be there verbatim. */
function cacheHeld(path: string, stashed: string, current: string): string | null {
  const lines = new Set(current.split("\n"));
  const keys = new Set([...lines].map(cacheKey).filter((k) => k !== null));
  for (const line of stashed.split("\n")) {
    if (!line.trim()) continue;
    const key = cacheKey(line);
    if (key === null ? !lines.has(line) : !keys.has(key)) return `${path} lacks cache entries the stash has`;
  }
  return null;
}

/** Why the working tree does not hold this version of the path, or null when it does. */
function unheld(root: string, claim: Claim): string | null {
  const { path, base, version } = claim;
  const file = resolve(root, path);
  let now: Stats | null = null;
  try {
    now = lstatSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return `${path} cannot be read`;
  }
  if (version === null) return now ? `${path} is deleted in the stash but present` : null;
  if (version.mode === "160000") return `${path} is a submodule change`;
  if (now === null) return `${path} is missing`;
  if (version.mode === "120000") {
    const target = git(root, ["cat-file", "blob", version.oid], true).stdout;
    return now.isSymbolicLink() && readlinkSync(file) === target ? null : `${path} is not the stash's symlink`;
  }
  if (!now.isFile()) return `${path} is not a regular file`;
  // A mode the stash changes must be the mode the file has now.
  if ((base?.mode ?? "100644") !== version.mode && ((now.mode & 0o111) !== 0) !== (version.mode === "100755")) {
    return `${path} lacks the stash's file mode`;
  }
  if (git(root, ["hash-object", "--", path]).stdout === version.oid) return null;
  if (DERIVED_CACHES.has(path)) {
    const stashed = textOf(blobBytes(root, version, path));
    const current = textOf(readFileSync(file));
    if (stashed === null || current === null) return `${path} differs and is not text`;
    return cacheHeld(path, stashed, current);
  }
  // A file the stash adds is held only as the stash has it.
  if (base === null) return `${path} is not the file the stash adds`;
  // Conflict markers the stash did not have mean a resolution is unfinished,
  // and its text proves nothing.
  const current = textOf(readFileSync(file));
  const stashed = textOf(blobBytes(root, version, path));
  if (current !== null && markerLines(current) > (stashed === null ? 0 : markerLines(stashed))) {
    return `${path} holds conflict markers`;
  }
  return changeInContext(root, claim) ? null : `${path} lacks the stash's change in its context`;
}

/** Why `entry` would not apply cleanly now, or null when it would. */
function unclean(root: string, entry: StashEntry, paths: string[]): string | null {
  const status = git(root, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ...paths], true);
  if (status.code !== 0) return `git status failed: ${status.stderr}`;
  const dirty = status.stdout.split("\0").filter(Boolean).map((record) => record.slice(3));
  if (dirty.length > 0) return `its paths have local changes: ${dirty.join(", ")}`;
  // Fixed prefixes and no external diff or textconv: a user's diff config must not change the patch `apply` reads.
  const patch = Bun.spawnSync([
    "git", "-C", root, "stash", "show", "-p", "--include-untracked", "--binary", "--full-index",
    "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", entry.ref,
  ]);
  if (patch.exitCode !== 0) return `git stash show failed: ${new TextDecoder().decode(patch.stderr).trim()}`;
  const check = Bun.spawnSync(["git", "-C", root, "apply", "--check"], { stdin: patch.stdout });
  if (check.exitCode !== 0) return `it does not apply cleanly: ${new TextDecoder().decode(check.stderr).trim()}`;
  return null;
}

/** Run `git stash <verb> <ref>` only while `ref` still names the entry that was assessed. Returns why not, or null. */
function onEntry(root: string, entry: StashEntry, verb: "drop" | "pop"): string | null {
  if (git(root, ["rev-parse", "-q", "--verify", entry.ref]).stdout !== entry.sha) return "the stash changed during the run";
  const result = git(root, ["stash", verb, "-q", entry.ref]);
  return result.code === 0 ? null : `${verb} failed: ${result.stderr || result.stdout}`;
}

/**
 * Settle every stash entry, from the highest index down so the refs of the
 * ones still to come stay valid:
 * - its every change is already in the working tree (see `unheld`) → drop it,
 *   whatever made it;
 * - an autostash (subject exactly `autostash`) whose paths have no local
 *   changes and whose patch passes `git apply --check` → pop it;
 * - otherwise keep it, with the reason.
 * While the index has unmerged paths, or a merge, rebase, cherry-pick, revert
 * or am is in progress, every entry is kept: a half-resolved file can look as
 * if it held a change it is about to lose. `dryRun` reports what would happen
 * without dropping or popping, judging every entry against the tree as it is.
 */
export function reconcileStashes(root: string, opts: { dryRun?: boolean } = {}): StashReport {
  const report: StashReport = { dropped: [], popped: [], kept: [] };
  const entries = listStashes(root);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const blocked = blocker(root);
    if (blocked) {
      report.kept.push({ ...entry, reason: blocked });
      continue;
    }
    const claims = claimsOf(root, entry.sha);
    if (claims === null) {
      report.kept.push({ ...entry, reason: "not shaped like a stash entry" });
      continue;
    }
    let missing: string | null = null;
    for (const claim of claims) if ((missing = unheld(root, claim)) !== null) break;
    if (missing === null) {
      const failed = opts.dryRun ? null : onEntry(root, entry, "drop");
      if (failed) report.kept.push({ ...entry, reason: failed });
      else report.dropped.push({ ...entry, reason: "every change it holds is already in the working tree" });
      continue;
    }
    if (entry.message !== AUTOSTASH) {
      report.kept.push({ ...entry, reason: `not an autostash, and ${missing}` });
      continue;
    }
    const refused = unclean(root, entry, [...new Set(claims.map((claim) => claim.path))]);
    if (refused) {
      report.kept.push({ ...entry, reason: `${missing}, and ${refused}` });
      continue;
    }
    const failed = opts.dryRun ? null : onEntry(root, entry, "pop");
    if (failed) report.kept.push({ ...entry, reason: failed });
    else report.popped.push(entry);
  }
  return report;
}
