/**
 * The writable areas of an interactive agent worker (#1626): the brain's own
 * scratch area and its repository workspaces, bound read-write over the
 * read-only brain, and a writable `$HOME` for the turn. Everything here is
 * resolved once per worker by `prepareWorkerSandbox`
 * (`packages/ui-sdk/src/server/worker-launcher.ts`), which both builds the
 * bubblewrap mounts from the result and renders the agent's sandbox note from
 * it, so the note cannot describe a mount the worker does not get.
 *
 * Nothing here follows a symlink. Each writable directory must be a real
 * directory at its own path inside the brain, with no mount point at or below
 * it and no regular file whose inode has a name outside it: a hard link that
 * already exists on the host would otherwise make that other name writable
 * through the mount. A bind mount stops new hard links, renames and symlink
 * writes into the rest of the brain (`EXDEV`/`EROFS`); this walk covers the
 * links made before the turn.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";

/** Repo-relative scratch directory; core's `SCRATCH_DIR` names the same path. */
export const BRAIN_SCRATCH_DIR = ".brain/scratch";
/** Repo-relative workspace directory; always in core's default index exclusions. */
export const BRAIN_WORKSPACES_DIR = "workspaces";
/** Per-turn XDG directories on the worker's private `/tmp` when `$HOME` cannot be overlaid. */
export const WORKER_XDG_HOME = "/tmp/brain-worker-home";
export const WORKER_XDG_DIRS = {
  XDG_CONFIG_HOME: `${WORKER_XDG_HOME}/config`,
  XDG_CACHE_HOME: `${WORKER_XDG_HOME}/cache`,
  XDG_DATA_HOME: `${WORKER_XDG_HOME}/data`,
} as const;
/** Directory entries one walk may visit before the mount counts as unverified. */
export const WORKER_MOUNT_SCAN_LIMIT = 200_000;

export type WorkerHome =
  /** `bwrap --tmp-overlay` over this path: reads see the host home, writes vanish with the turn. */
  | { mode: "overlay"; path: string }
  /** `$HOME` stays read-only; the XDG variables point at per-turn directories. */
  | { mode: "xdg"; reason: string };

/** One writable area: bound read-write, or named with why it is not. `missing`: the directory does not exist. */
export type WorkerMount = { writable: true; path: string } | { writable: false; reason: string; missing?: true };

/**
 * The named writable areas a worker may receive inside the read-only brain.
 * A caller chooses which ones a worker gets (`prepareWorkerSandbox`'s `areas`);
 * the launcher binds exactly the writable ones and the note describes them.
 */
export const WORKER_AREAS = {
  scratch: BRAIN_SCRATCH_DIR,
  workspaces: BRAIN_WORKSPACES_DIR,
} as const;
export type WorkerAreaName = keyof typeof WORKER_AREAS;

export interface WorkerArea {
  readonly name: WorkerAreaName;
  readonly mount: WorkerMount;
}

export interface WorkerSandbox {
  /** Canonical brain path the layout was resolved for. */
  readonly brain: string;
  readonly restricted: boolean;
  /** The areas resolved for this worker, in mount order. Empty in a restricted turn. */
  readonly areas: readonly WorkerArea[];
  /** Repo-relative scratch names unlinked because their file had a name outside scratch. */
  readonly scratchAliasesRemoved: readonly string[];
  /** Absent in a restricted turn, whose home is its runtime state. */
  readonly home?: WorkerHome;
}

function decode(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Mount points at or below `dir`, from the server's own mount table. */
export function mountPointsUnder(dir: string): string[] {
  if (process.platform !== "linux") return [];
  return readFileSync("/proc/self/mountinfo", "utf8").split("\n")
    .map(line => line.split(" ")[4]).filter((mount): mount is string => Boolean(mount)).map(decode)
    .filter(mount => mount === dir || mount.startsWith(`${dir}/`));
}

/**
 * The real directory `<brain>/<rel>`, every segment checked with `lstat`.
 * `create` makes missing segments (never through a link); otherwise a missing
 * directory is `null`. A link or non-directory anywhere is a refusal string.
 */
export function realBrainDirectory(brain: string, rel: string, create: boolean): string | null | { refused: string } {
  let path = brain;
  for (const segment of rel.split("/")) {
    path = join(path, segment);
    let info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) {
      if (!create) return null;
      try { mkdirSync(path, { mode: 0o755 }); } catch (error) {
        return { refused: `${relative(brain, path)} could not be created (${(error as NodeJS.ErrnoException).code ?? error})` };
      }
      info = lstatSync(path);
    }
    if (info.isSymbolicLink()) return { refused: `${relative(brain, path)} is a symlink` };
    if (!info.isDirectory()) return { refused: `${relative(brain, path)} is not a directory` };
  }
  if (realpathSync(path) !== path) return { refused: `${rel} does not resolve to itself` };
  return path;
}

export interface AliasScan {
  /** Repo-relative paths of regular files whose inode also has a name outside the walked directory. */
  outside: string[];
  /** A directory inside is the brain root itself (a bind or loop the walk must not trust). */
  brainInside: boolean;
  /** The walk stopped at the entry limit. */
  overLimit: boolean;
}

/**
 * Walks `dir` with `lstat` only, never descending a symlink, and counts the
 * names each regular file's inode has inside it. An inode with more links
 * than names found here has a name elsewhere: links wholly inside the mount
 * (git's local clones, package stores) are harmless and are not reported.
 */
export function scanForOutsideLinks(brain: string, dir: string, limit = WORKER_MOUNT_SCAN_LIMIT): AliasScan {
  const root = lstatSync(brain);
  const files = new Map<string, { nlink: number; paths: string[] }>();
  const stack = [dir];
  let seen = 0, brainInside = false, overLimit = false;
  while (stack.length) {
    const current = stack.pop()!;
    let names: string[];
    try { names = readdirSync(current); } catch { continue; }
    for (const name of names) {
      if (++seen > limit) { overLimit = true; stack.length = 0; break; }
      const path = join(current, name);
      const info = lstatSync(path, { throwIfNoEntry: false, bigint: true });
      if (!info) continue;
      if (info.isDirectory()) {
        if (info.dev === BigInt(root.dev) && info.ino === BigInt(root.ino)) brainInside = true;
        stack.push(path);
      } else if (info.isFile() && info.nlink > 1n) {
        const key = `${info.dev}:${info.ino}`;
        const entry = files.get(key) ?? { nlink: Number(info.nlink), paths: [] };
        entry.paths.push(path);
        files.set(key, entry);
      }
    }
  }
  const outside = [...files.values()].filter(entry => entry.nlink > entry.paths.length)
    .flatMap(entry => entry.paths).map(path => relative(brain, path)).sort();
  return { outside, brainInside, overLimit };
}

/**
 * Whether git excludes the scratch directory, asked of git itself as core's
 * `scratchIgnored` does. A brain that is not a repository has nothing to
 * commit it into; core still refuses its own scratch writes until it is.
 */
function scratchIgnoredByGit(brain: string): true | { refused: string } {
  if (!lstatSync(join(brain, ".git"), { throwIfNoEntry: false })) return true;
  const git = Bun.which("git");
  if (!git) return { refused: "git is not available to confirm .brain/scratch/ is gitignored" };
  const result = Bun.spawnSync([git, "check-ignore", "-q", "--no-index", "--", BRAIN_SCRATCH_DIR],
    { cwd: brain, env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" });
  if (result.exitCode === 0) return true;
  return { refused: result.exitCode === 1
    ? ".brain/scratch/ is not gitignored, so a file written there could be committed; run `brain doctor --fix` outside a hosted turn"
    : "git could not confirm .brain/scratch/ is gitignored" };
}

/** Repo-relative path for a server log line or the note; never an absolute host path. */
function shown(paths: readonly string[]): string {
  return paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
}

/**
 * `<brain>/.brain/scratch`, created when missing and bound read-write when it
 * is a real, gitignored directory with no mount below it. A scratch name whose
 * file also has a name outside scratch is unlinked first: scratch is
 * disposable, and the other name keeps its data.
 */
export function resolveScratchMount(brain: string): { mount: WorkerMount; removed: string[] } {
  const dir = realBrainDirectory(brain, BRAIN_SCRATCH_DIR, true);
  if (dir === null || typeof dir === "object") return { mount: { writable: false, reason: dir?.refused ?? "missing" }, removed: [] };
  const ignored = scratchIgnoredByGit(brain);
  if (ignored !== true) return { mount: { writable: false, reason: ignored.refused }, removed: [] };
  if (mountPointsUnder(dir).length) return { mount: { writable: false, reason: ".brain/scratch/ is or contains a mount point" }, removed: [] };
  const scan = scanForOutsideLinks(brain, dir);
  if (scan.overLimit) return { mount: { writable: false, reason: `.brain/scratch/ holds more than ${WORKER_MOUNT_SCAN_LIMIT} entries; run \`brain scratch prune\`` }, removed: [] };
  if (scan.brainInside) return { mount: { writable: false, reason: ".brain/scratch/ contains the brain itself" }, removed: [] };
  const removed: string[] = [];
  for (const rel of scan.outside) {
    const path = join(brain, rel);
    try { if (lstatSync(path).isFile()) unlinkSync(path); removed.push(rel); }
    catch (error) {
      return { mount: { writable: false, reason: `the scratch alias ${rel} could not be removed (${(error as NodeJS.ErrnoException).code ?? error})` }, removed };
    }
  }
  return { mount: { writable: true, path: dir }, removed };
}

/**
 * `<brain>/workspaces`, bound read-write only when it already exists as a
 * real directory: creating it outside a hosted turn is the opt-in. Core
 * always excludes it from the index, so it holds no authoritative document.
 * Any file in it with a name outside it, a mount below it or a walk past the
 * limit leaves it read-only for the turn.
 */
export function resolveWorkspacesMount(brain: string): WorkerMount {
  const dir = realBrainDirectory(brain, BRAIN_WORKSPACES_DIR, false);
  if (dir === null) return { writable: false, reason: "workspaces/ does not exist", missing: true };
  if (typeof dir === "object") return { writable: false, reason: dir.refused };
  if (mountPointsUnder(dir).length) return { writable: false, reason: "workspaces/ is or contains a mount point" };
  const scan = scanForOutsideLinks(brain, dir);
  if (scan.overLimit) return { writable: false, reason: `workspaces/ holds more than ${WORKER_MOUNT_SCAN_LIMIT} entries, too many to verify` };
  if (scan.brainInside) return { writable: false, reason: "workspaces/ contains the brain itself" };
  if (scan.outside.length) return { writable: false, reason: `hard-linked to files outside workspaces/: ${shown(scan.outside)}` };
  return { writable: true, path: dir };
}


const TURN_TEMP_HEADING = "1. **Turn temp: deleted when the turn ends.**";
const BRAIN_LINE = "3. **The brain: canonical, and read-only here.** Change Markdown only through the brain write and edit tools; any other write, `git commit` or index command in the brain fails with `Read-only file system`. Hard links, renames and symlinks from the writable areas into it fail too: that is the sandbox, not something to work around.";

/** The persistent-scratch lines for each state an area's mount can be in. */
const AREA_LINES: Record<WorkerAreaName, (mount: WorkerMount) => string> = {
  scratch: mount => mount.writable
    ? "   - `.brain/scratch/` is writable (pruned after 7 days, oldest first past 1 GB). **Put anything you link in your response here, never in turn temp.** Use `brain render --scratch` or `brain image --scratch`, or write the file there, then link its repo-relative path, such as `.brain/scratch/<name>.pdf`. It is the only place outside the brain's own documents you may link to."
    : `   - \`.brain/scratch/\` is read-only this turn: ${mount.reason}. There is nowhere to put a file for the reader; say so instead of linking a turn-temp file.`,
  workspaces: mount => mount.writable
    ? "   - `workspaces/` is writable: clone, fetch and commit other repositories there, never in `/tmp`."
    : mount.missing
      ? "   - There is no `workspaces/` directory, so no persistent place for repository clones. It becomes writable in later turns once someone creates `workspaces/` in the brain outside a hosted turn; until then a clone in `/tmp` is lost at turn end."
      : `   - \`workspaces/\` is read-only this turn: ${mount.reason}.`,
};

/**
 * The note the agent reads before it starts: the three places a file can be
 * (turn temp, persistent scratch, the brain) and which of them this worker
 * can write. Rendered only from the resolved sandbox that also builds the
 * worker's mounts, so it describes exactly the mounts the worker gets.
 */
export function workerSandboxNote(sandbox: WorkerSandbox): string {
  const lines: string[] = [];
  if (sandbox.restricted) {
    lines.push(
      "This is a restricted (autonomous) turn: no network except the inference relay, no host home, and the brain's `.git` is hidden.",
      "",
      `${TURN_TEMP_HEADING} \`$BRAIN_WORKER_SCRATCH\` and \`/tmp\` are the only writable places. Nothing written there reaches the reader; never link to it.`,
      "2. **No persistent scratch.** `.brain/scratch/` and `workspaces/` are read-only in this turn.",
      "3. **The brain: canonical, and read-only here.** Change it only through the approved brain tools.",
    );
  } else {
    const home = sandbox.home?.mode === "overlay"
      ? "and anything written under `$HOME`"
      : `and the per-turn \`XDG_CONFIG_HOME\`, \`XDG_CACHE_HOME\` and \`XDG_DATA_HOME\` under \`${WORKER_XDG_HOME}\` (\`$HOME\` itself is read-only)`;
    lines.push(
      "Files live in three places, and only two of them survive this turn.",
      "",
      `${TURN_TEMP_HEADING} \`$BRAIN_WORKER_SCRATCH\`, \`/tmp\` ${home}. Use it for intermediate work only. **Never link to a file here in a response**: the reader cannot open it, and it is gone after the turn.`,
      sandbox.areas.some(area => area.mount.writable)
        ? "2. **Persistent scratch: kept across turns.** Any file the reader should open or download goes here."
        : "2. **Persistent scratch: unavailable this turn.**",
      ...sandbox.areas.map(area => AREA_LINES[area.name](area.mount)),
      ...(sandbox.areas.length ? [] : ["   - No directory outside the brain's documents is writable this turn."]),
      BRAIN_LINE,
    );
  }
  return `# Where files go in this turn\n\n${lines.join("\n")}`;
}

/**
 * What the server log should say about a resolved sandbox: each area that
 * exists but stays read-only, and each scratch alias removed. Repo-relative
 * paths only. An absent workspace directory is the default, not a warning.
 */
export function workerSandboxWarnings(sandbox: WorkerSandbox): string[] {
  const warnings = sandbox.areas.flatMap(({ name, mount }) =>
    !mount.writable && !mount.missing ? [`worker ${name} area is read-only this turn: ${mount.reason}`] : []);
  if (sandbox.scratchAliasesRemoved.length) {
    warnings.push(`removed scratch names hard-linked to files outside scratch: ${shown(sandbox.scratchAliasesRemoved)}`);
  }
  return warnings;
}
