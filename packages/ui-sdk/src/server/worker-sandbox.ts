/**
 * The writable areas of an interactive agent worker (#1626): the brain's own
 * scratch area and its repository workspaces, bound read-write over the
 * read-only brain, and per-turn XDG directories in turn temp. Everything here is
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
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { BRAIN_SCRATCH_DIR, BRAIN_WORKSPACES_DIR, linkRule, READ_ONLY_BRAIN_RULE, TURN_TEMP_RULE } from "@schlessera/brain-common/internal/worker-areas";
import { brainGitSync } from "./maintenance-worker.js";

/**
 * Repo-relative scratch directory (core's `SCRATCH_DIR` names the same path)
 * and workspace directory (always in core's default index exclusions).
 */
export { BRAIN_SCRATCH_DIR, BRAIN_WORKSPACES_DIR };
/**
 * Per-turn XDG directories on the worker's private `/tmp` (#1703). `$HOME`
 * itself stays the host's, read-only.
 */
export const WORKER_XDG_HOME = "/tmp/brain-worker-home";
export const WORKER_XDG_DIRS = {
  XDG_CONFIG_HOME: `${WORKER_XDG_HOME}/config`,
  XDG_CACHE_HOME: `${WORKER_XDG_HOME}/cache`,
  XDG_DATA_HOME: `${WORKER_XDG_HOME}/data`,
} as const;
/** Directory entries one walk may visit before the mount counts as unverified. */
export const WORKER_MOUNT_SCAN_LIMIT = 200_000;

/**
 * `$HOME` stays read-only; the XDG variables point at per-turn directories in
 * turn temp. There is no per-turn home overlay: bubblewrap keeps an overlay's
 * writes on the host side, outside the worker's size-limited `/tmp` (#1703).
 */
export type WorkerHome = { mode: "xdg" };

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
/** Strict workers write named areas outside their configuration execution view. */
export const WORKER_AREA_ROOT = "/tmp/brain-worker-areas";

export interface WorkerArea {
  readonly name: WorkerAreaName;
  /** Repo-relative directory the area was resolved at; the note names the area by this path. */
  readonly rel: string;
  readonly mount: WorkerMount;
}

export interface WorkerSandbox {
  /** Frozen host scope policy; absent for autonomous turns. */
  readonly scopePolicy?: { max_files_changed: number; max_minutes: number; max_tool_calls: number; max_bytes_written: number };
  /** Frozen host command rules from this turn's admitted policy, absent for autonomous turns. */
  readonly commandPolicy?: import("./command-policy.js").WorkerCommandPolicy;
  /** @internal Concrete host-prepared turn transport; never selected by client/project input. */
  readonly egress?: Awaited<ReturnType<typeof import("./egress-proxy.js").startEgressProxy>>;
  /** @internal Advisory facts resolved by the admitting host, never a model grant. */
  readonly noteFacts?: WorkerNoteFacts;
  /** Canonical brain path the layout was resolved for. */
  readonly brain: string;
  readonly restricted: boolean;
  /** Resolved filesystem profile. Omitted legacy layouts are strict. */
  readonly profile?: WorkerProfile;
  /** Why a requested governed turn had to use the stronger strict profile. */
  readonly fallbackReason?: string;
  /** Protected mounts and their ancestors, resolved before the start manifest. */
  readonly protection?: WorkerProtection;
  /** Frozen topology plan for host publication; does not grant access to provider-restricted data. */
  readonly retainedFolders?: readonly string[];
  /** Runtime paths to restore below the host masks, read-only. */
  readonly readPaths?: readonly string[];
  /** Host-private operational state, hidden in addition to the standard masks. */
  readonly maskPaths?: readonly string[];
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

/** One offending name, as raw bytes below the walked directory, with the inode the walk counted. */
export interface ScannedAlias {
  /** Repo-relative path for logs and the note (bytes that are not UTF-8 shown as U+FFFD). */
  readonly rel: string;
  /** The path's segments below the walked directory, exactly as the directory holds them. */
  readonly segments: readonly Buffer[];
  /** `dev:ino` of the file the walk counted. */
  readonly inode: string;
}

export interface AliasScan {
  /** Repo-relative paths of regular files whose inode also has a name outside the walked directory. */
  outside: string[];
  /** The same files, addressable for a removal. */
  aliases: ScannedAlias[];
  /** A directory inside is the brain root itself (a bind or loop the walk must not trust). */
  brainInside: boolean;
  /** The walk stopped at the entry limit. */
  overLimit: boolean;
  /** Why the walk could not see everything (an unreadable directory, a tree changing under it); the area is unverified. */
  unverified?: string;
}

/** Directory entries are opened without following a final symlink, and only as directories. */
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** Deeper nesting than this is not walked; the area counts as unverified. */
const SCAN_DEPTH_LIMIT = 256;
/** A walk that saw the tree change is repeated this many times before the area counts as unverified. */
const SCAN_ATTEMPTS = 3;

/** A path resolved through an open directory descriptor, so a rename or symlink swap of an ancestor cannot redirect it. */
export function at(fd: number, name: Buffer | string): Buffer {
  return Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), typeof name === "string" ? Buffer.from(name) : name]);
}

/** Opens `path` (absolute, or anchored by `at`) as a directory; the caller closes it. */
export function openDirectory(path: string | Buffer): number {
  return openSync(path, DIRECTORY_FLAGS);
}

/** `dir` and raw name segments joined with `/`, without decoding the names. */
function bytePath(dir: string, segments: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(dir), ...segments.flatMap(segment => [Buffer.from("/"), segment])]);
}

function code(error: unknown): string {
  return String((error as NodeJS.ErrnoException).code ?? error);
}

class Unverified extends Error {
  constructor(message: string, readonly retry: boolean) { super(message); }
}

type DirectoryStamp = { segments: Buffer[]; dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint };

/**
 * Walks `dir` and counts the names each regular file's inode has inside it.
 * An inode with more links than names found here has a name elsewhere: links
 * wholly inside the mount (git's local clones, package stores) are harmless
 * and are not reported.
 *
 * A concurrent worker can write the area while the host walks it, so the
 * walk trusts nothing by name. Names are read as raw bytes. Each directory is
 * opened with `O_NOFOLLOW | O_DIRECTORY` through its parent's descriptor and
 * must be the inode `lstat` reported, so a symlink swapped in is never
 * followed. Every directory's change and modification times are taken before
 * it is listed and compared once the walk is done: a rename that moved a name
 * between directories (which could make one inode count twice, or not at
 * all) shows there, as does an entry that vanished. Such a walk is repeated,
 * and after three tries the result is `unverified`. A directory or
 * entry it cannot read (an execute-only directory hides its names, so a link
 * could sit behind it) is `unverified` at once.
 */
export function scanForOutsideLinks(brain: string, dir: string, limit = WORKER_MOUNT_SCAN_LIMIT): AliasScan {
  let result: AliasScan | undefined;
  for (let attempt = 1; attempt <= SCAN_ATTEMPTS; attempt++) {
    try { return scanOnce(brain, dir, limit); } catch (error) {
      if (!(error instanceof Unverified)) throw error;
      result = { outside: [], aliases: [], brainInside: false, overLimit: false, unverified: error.message };
      if (!error.retry) break;
    }
  }
  return result!;
}

function scanOnce(brain: string, dir: string, limit: number): AliasScan {
  const result: AliasScan = { outside: [], aliases: [], brainInside: false, overLimit: false };
  if (process.platform !== "linux") throw new Unverified("the walk needs Linux's /proc/self/fd", false);
  const root = lstatSync(brain, { bigint: true });
  const base = relative(brain, dir);
  const shownPath = (segments: readonly Buffer[]) => [base, ...segments.map(segment => segment.toString())].join("/");
  const files = new Map<string, { nlink: bigint; paths: Buffer[][] }>();
  const stamps: DirectoryStamp[] = [];
  let seen = 0;
  const walk = (fd: number, segments: Buffer[]): void => {
    if (segments.length > SCAN_DEPTH_LIMIT) throw new Unverified(`${shownPath(segments)} is nested too deeply to verify`, false);
    const before = fstatSync(fd, { bigint: true });
    stamps.push({ segments, dev: before.dev, ino: before.ino, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs });
    let names: Buffer[];
    try { names = readdirSync(at(fd, "."), { encoding: "buffer" }); } catch (error) {
      throw new Unverified(`${shownPath(segments)} cannot be listed (${code(error)})`, false);
    }
    for (const name of names) {
      if (++seen > limit) { result.overLimit = true; return; }
      const child = [...segments, name];
      let info;
      try { info = lstatSync(at(fd, name), { bigint: true }); } catch (error) {
        throw new Unverified(`${shownPath(child)} cannot be inspected (${code(error)})`, code(error) === "ENOENT");
      }
      if (info.isDirectory()) {
        if (info.dev === root.dev && info.ino === root.ino) { result.brainInside = true; continue; }
        let childFd: number;
        try { childFd = openDirectory(at(fd, name)); } catch (error) {
          const retry = ["ENOENT", "ELOOP", "ENOTDIR"].includes(code(error));
          throw new Unverified(`${shownPath(child)} cannot be opened (${code(error)})`, retry);
        }
        try {
          const opened = fstatSync(childFd, { bigint: true });
          if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Unverified(`${shownPath(child)} changed while it was walked`, true);
          walk(childFd, child);
        } finally { closeSync(childFd); }
        if (result.overLimit) return;
      } else if (info.isFile() && info.nlink > 1n) {
        const key = `${info.dev}:${info.ino}`;
        const entry = files.get(key) ?? { nlink: info.nlink, paths: [] };
        entry.paths.push(child);
        files.set(key, entry);
      }
    }
  };
  let fd: number;
  try { fd = openDirectory(dir); } catch (error) {
    throw new Unverified(`${base} cannot be opened (${code(error)})`, false);
  }
  try { walk(fd, []); } finally { closeSync(fd); }
  // Every directory must be as it was when it was listed: same inode at the
  // same place, nothing added, removed or renamed in it since.
  for (const stamp of stamps) {
    let now;
    try { now = lstatSync(bytePath(dir, stamp.segments), { bigint: true }); }
    catch { throw new Unverified(`${shownPath(stamp.segments)} changed while it was walked`, true); }
    if (now.dev !== stamp.dev || now.ino !== stamp.ino || now.mtimeNs !== stamp.mtimeNs || now.ctimeNs !== stamp.ctimeNs) {
      throw new Unverified(`${shownPath(stamp.segments)} changed while it was walked`, true);
    }
  }
  for (const [inode, entry] of files) {
    if (entry.nlink <= BigInt(entry.paths.length)) continue;
    for (const segments of entry.paths) {
      const rel = shownPath(segments);
      result.outside.push(rel);
      result.aliases.push({ rel, segments, inode });
    }
  }
  result.outside.sort();
  result.aliases.sort((a, b) => a.rel.localeCompare(b.rel));
  return result;
}

/**
 * Unlinks the scanned alias below `dir` only if it is still the regular file
 * the walk saw. Every directory on the way is opened through its parent's
 * descriptor with `O_NOFOLLOW`, and the unlink goes through the last one, so
 * a symlink swapped in mid-way cannot redirect it out of `dir`.
 */
function unlinkScanned(dir: string, alias: ScannedAlias): void {
  const segments = [...alias.segments];
  const name = segments.pop()!;
  let fd = openDirectory(dir);
  try {
    for (const segment of segments) {
      const next = openDirectory(at(fd, segment));
      closeSync(fd);
      fd = next;
    }
    const info = lstatSync(at(fd, name), { bigint: true });
    if (!info.isFile() || `${info.dev}:${info.ino}` !== alias.inode) {
      throw Object.assign(new Error(`${alias.rel} changed after the walk`), { code: "ECHANGED" });
    }
    unlinkSync(at(fd, name));
  } finally { closeSync(fd); }
}

/**
 * Whether git excludes the scratch directory, asked of git itself as core's
 * `scratchIgnored` does, and in the same cases: the brain has its own `.git`
 * or sits inside a parent repository (`isGitRepo`). A brain in no repository
 * has nothing to commit it into; core still refuses its own scratch writes
 * until it is ignored. Git reads the brain's configuration, so it runs in a
 * credential-free maintenance worker (#1648), which names the brain a safe
 * directory itself; a worker that cannot run leaves scratch read-only.
 */
function scratchIgnoredByGit(brain: string, maintenance?: import("./maintenance-worker.js").MaintenanceHost): true | { refused: string } {
  const git = Bun.which("git");
  const own = Boolean(lstatSync(join(brain, ".git"), { throwIfNoEntry: false }));
  if (!own) {
    if (!git) return true;
    const inRepo = brainGitSync(brain, ["rev-parse", "--git-dir"], maintenance);
    if (inRepo === 127) return { refused: "git could not run to confirm .brain/scratch/ is gitignored" };
    if (inRepo !== 0) return true;
  }
  if (!git) return { refused: "git is not available to confirm .brain/scratch/ is gitignored" };
  const exitCode = brainGitSync(brain, ["check-ignore", "-q", "--no-index", "--", BRAIN_SCRATCH_DIR], maintenance);
  if (exitCode === 0) return true;
  return { refused: exitCode === 1
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
export function resolveScratchMount(brain: string, maintenance?: import("./maintenance-worker.js").MaintenanceHost): { mount: WorkerMount; removed: string[] } {
  const dir = realBrainDirectory(brain, BRAIN_SCRATCH_DIR, true);
  if (dir === null || typeof dir === "object") return { mount: { writable: false, reason: dir?.refused ?? "missing" }, removed: [] };
  if (mountPointsUnder(dir).length) return { mount: { writable: false, reason: ".brain/scratch/ is or contains a mount point" }, removed: [] };
  const scan = scanForOutsideLinks(brain, dir);
  if (scan.overLimit) return { mount: { writable: false, reason: `.brain/scratch/ holds more than ${WORKER_MOUNT_SCAN_LIMIT} entries; run \`brain scratch prune\`` }, removed: [] };
  if (scan.unverified) return { mount: { writable: false, reason: `.brain/scratch/ could not be verified: ${scan.unverified}` }, removed: [] };
  if (scan.brainInside) return { mount: { writable: false, reason: ".brain/scratch/ contains the brain itself" }, removed: [] };
  const removed: string[] = [];
  for (const alias of scan.aliases) {
    const rel = alias.rel;
    try { unlinkScanned(dir, alias); removed.push(rel); }
    catch (error) {
      return { mount: { writable: false, reason: `the scratch alias ${rel} could not be removed (${(error as NodeJS.ErrnoException).code ?? error})` }, removed };
    }
  }
  const ignored = scratchIgnoredByGit(brain, maintenance);
  if (ignored !== true) return { mount: { writable: false, reason: ignored.refused }, removed };
  return { mount: { writable: true, path: dir }, removed };
}

/**
 * `<brain>/workspaces`, bound read-write only when it already exists as a
 * real directory: creating it outside a hosted turn is the opt-in. Core
 * always excludes it from the index, so it holds no authoritative document.
 * Any file in it with a name outside it, a mount below it or a walk past the
 * limit leaves it read-only for the turn.
 */
export function resolveWorkspacesMount(brain: string, limit = WORKER_MOUNT_SCAN_LIMIT): WorkerMount {
  const dir = realBrainDirectory(brain, BRAIN_WORKSPACES_DIR, false);
  if (dir === null) return { writable: false, reason: "workspaces/ does not exist", missing: true };
  if (typeof dir === "object") return { writable: false, reason: dir.refused };
  if (mountPointsUnder(dir).length) return { writable: false, reason: "workspaces/ is or contains a mount point" };
  const scan = scanForOutsideLinks(brain, dir, limit);
  if (scan.overLimit) return { writable: false, reason: `workspaces/ holds more than ${limit} entries, too many to verify` };
  if (scan.unverified) return { writable: false, reason: `workspaces/ could not be verified: ${scan.unverified}` };
  if (scan.brainInside) return { writable: false, reason: "workspaces/ contains the brain itself" };
  if (scan.outside.length) return { writable: false, reason: `hard-linked to files outside workspaces/: ${shown(scan.outside)}` };
  return { writable: true, path: dir };
}

/**
 * The resolved worker profile: `strict` keeps the brain read-only, `governed`
 * makes it writable except its resolved protected paths, and `restricted` is
 * the autonomous envelope. The note describes the same resolved layout.
 */
export type WorkerProfile = "governed" | "strict" | "restricted";

export interface ProtectedWorkerPath {
  readonly rel: string;
  readonly reason: string;
  readonly mode: "read_only" | "mask_file" | "mask_directory" | "absent";
}
export interface WorkerProtection {
  readonly paths: readonly ProtectedWorkerPath[];
  readonly ancestors: readonly string[];
}

export function workerProfile(sandbox: WorkerSandbox): WorkerProfile {
  return sandbox.restricted ? "restricted" : sandbox.profile ?? "strict";
}

/**
 * One limit that applies to this worker: its resolved value and what hitting
 * it looks like. Each owner renders its own from the input that enforces it,
 * such as the worker-state allowance (#1625) and the resource limits (#1660);
 * the note states them as given and invents none.
 */
export interface WorkerNoteLimit {
  /** What is limited, such as "Runtime state". */
  readonly name: string;
  /** The resolved value, such as "64 MiB". */
  readonly value: string;
  /** What the agent sees when it hits the limit, and what to do instead. */
  readonly onHit: string;
}

/** Facts resolved outside the mount list that the note states with it. */
export interface WorkerNoteFacts {
  /** Actual successful host qualification, never a configured helper path alone. */
  readonly identity?: { readonly kind: "separate_uid"; readonly workerUid: number };
  readonly limits?: readonly WorkerNoteLimit[];
  /** Only actual host services and this admitted observation window supply these facts. */
  readonly history?: { readonly journal: boolean; readonly userRevert: boolean };
  readonly hardTimeoutMs?: number;
}

const SHARED_UID_NOTE = "The worker shares the server's uid; server state is protected by masks only. A read-only brain does not prevent access to other host paths available to that uid.";

/** The line naming an interactive worker's profile and what it lets the agent do to the brain. */
const PROFILE_LINES: Record<Exclude<WorkerProfile, "restricted">, (sandbox: WorkerSandbox, identityNote: string) => string> = {
  governed: (sandbox, identityNote) => `**Profile: \`governed\`.** The brain is writable, except the protected paths below. Direct Markdown changes are indexed after the turn.\n${(sandbox.protection?.paths ?? []).map(path => `- \`${path.rel}\`: ${path.reason} (${path.mode === "absent" ? "quarantined if created" : path.mode === "read_only" ? "read-only" : "masked"}).`).join("\n")}\nHost runtime and home directories are masked. ${identityNote} Egress is unrecorded. Maintenance workers may receive provider credentials until inference relays land.`,
  strict: (sandbox, identityNote) => `**Profile: \`strict\`.** ${sandbox.fallbackReason ? `Governed was unavailable: ${sandbox.fallbackReason}. ` : ""}${READ_ONLY_BRAIN_RULE} Any other write, \`git commit\` or index command in the brain fails with \`EROFS\` (\`Read-only file system\`), and so do hard links, renames and symlinks from the writable areas into it: that is the sandbox, not something to work around.\n${identityNote}`,
};

/** The line for each state an area's mount can be in, naming the area by its resolved path. */
const AREA_LINES: Record<WorkerAreaName, (area: WorkerArea, target: string) => string> = {
  scratch: ({ rel, mount }, target) => mount.writable
    ? `   - \`${target}/\` is writable. Write the file there, then link its repo-relative destination, such as \`${rel}/<name>.pdf\`.`
    : `   - \`${rel}/\` is read-only this turn: ${mount.reason}. There is nowhere to put a file for the reader; say so instead of linking a turn-temp file.`,
  workspaces: ({ rel, mount }, target) => mount.writable
    ? `   - \`${target}/\` is writable: clone, fetch and commit other repositories there, never in \`/tmp\`.`
    : mount.missing
      ? `   - There is no \`${rel}/\` directory, so a repository clone is lost at turn end. Creating \`${rel}/\` in the brain outside a hosted turn makes it writable in later turns.`
      : `   - \`${rel}/\` is read-only this turn: ${mount.reason}.`,
};

/** What this worker's turn temp covers. */
function turnTempPlaces(): string {
  return `\`$BRAIN_WORKER_SCRATCH\`, \`/tmp\` and the per-turn \`XDG_CONFIG_HOME\`, \`XDG_CACHE_HOME\` and \`XDG_DATA_HOME\` under \`${WORKER_XDG_HOME}\` (\`$HOME\` itself is read-only: a write there fails with \`EROFS\`, so point the tool at an XDG directory or \`/tmp\`)`;
}

/**
 * The note the agent reads before it starts: its profile, the three places a
 * file can be (turn temp, persistent areas, the brain) and which of them it
 * can write, where a link may point, and the limits that apply. Rendered only
 * from the resolved sandbox that also builds the worker's mounts and from
 * facts their owners resolved, so it describes exactly the worker it goes
 * to. Both backends inject this text unchanged. The restricted (autonomous)
 * variant is the envelope's own and keeps its wording.
 */
export function workerSandboxNote(sandbox: WorkerSandbox, facts: WorkerNoteFacts = {}): string {
  const lines: string[] = [];
  const resolvedFacts = { ...sandbox.noteFacts, ...facts };
  const profile = workerProfile(sandbox);
  const identityNote = resolvedFacts.identity?.kind === "separate_uid" && Number.isSafeInteger(resolvedFacts.identity.workerUid) && resolvedFacts.identity.workerUid > 0
    ? `The worker runs under a verified separate non-root uid (${resolvedFacts.identity.workerUid}); server-private state remains protected by ownership as well as masks. Recovery is bounded best-effort after verified worker-tree termination; external references may outlive that tree.`
    : SHARED_UID_NOTE;
  if (profile === "restricted") {
    lines.push(
      "This is a restricted (autonomous) turn: no network except the inference relay, no host home, and the brain's `.git` is hidden.",
      "",
      "1. **Turn temp: deleted when the turn ends.** `$BRAIN_WORKER_SCRATCH`, `/tmp` and `$HOME` (the turn's own state, never the host home) are the only writable places. Nothing written there reaches the reader; never link to it.",
      `2. **No persistent scratch.** \`${WORKER_AREAS.scratch}/\` and \`${WORKER_AREAS.workspaces}/\` are read-only in this turn.`,
      "3. **The brain: canonical, and read-only here.** Change it only through the approved brain tools.",
    );
  } else {
    const scratch = sandbox.areas.find(area => area.name === "scratch" && area.mount.writable);
    lines.push(
      PROFILE_LINES[profile](sandbox, identityNote),
      "",
      `1. **Turn temp:** ${turnTempPlaces()}. ${TURN_TEMP_RULE}`,
      sandbox.areas.some(area => area.mount.writable)
        ? "2. **Persistent areas: kept across turns.**"
        : "2. **Persistent areas: none writable this turn.**",
      ...sandbox.areas.map(area => AREA_LINES[area.name](area, profile === "governed" ? area.rel : `${WORKER_AREA_ROOT}/${area.name}`)),
      ...(profile === "strict" ? ["Configuration executes from an immutable startup view, including imported helpers and absent names.",
        ...sandbox.areas.filter(area => area.mount.writable).map(area =>
          `Write \`${area.rel}/\` through \`${WORKER_AREA_ROOT}/${area.name}/\`, outside that view; link the repo-relative destination.`)] : []),
      ...(sandbox.areas.length ? [] : ["   - No directory outside the brain's documents is writable this turn."]),
      "3. **The brain: canonical and versioned.**",
      "",
      linkRule(scratch?.rel),
      `The brain's packaged CLI directory \`${join(sandbox.brain, "node_modules", ".bin")}\` is first on PATH.`,
      ...(!existsSync(join(sandbox.brain, "node_modules", ".bin", "brain"))
        ? ["The packaged `brain` CLI is missing. Install `@schlessera/brain` in the brain repository and run `bun install` there before using `brain` commands."] : []),
    );
  }
  if (profile !== "restricted" && sandbox.retainedFolders?.length) {
    lines.push("", `Keep these folders and their ancestors in place: ${sandbox.retainedFolders.map(path => `\`${path}\``).join(", ")}. Their contents keep the usual write permissions; do not remove or replace the folders themselves.`);
  }
  if (profile !== "restricted" && (profile === "governed" || resolvedFacts.history)) {
    const history = resolvedFacts.history;
    lines.push("", !history
      ? "Host change journaling and user history restoration availability was not supplied; do not promise retained versions or recovery."
      : !history.journal
        ? "Host change journaling is unavailable for this turn; do not promise retained raw versions or recovery. User history restoration is unavailable for this turn."
        : `Host change journaling is active for this turn. Only observed raw versions are retained; writes overwritten between observations cannot be recovered. ${history.userRevert
          ? "User history can revert retained observed paths and Undo the recorded user operation; changed paths are skipped as conflicts."
          : "User history restoration is unavailable for this turn."} Only the authenticated user can trigger history restoration; the agent has no revert or Undo tool. No automatic revert occurs.`);
  }
  if (profile !== "restricted" && sandbox.scopePolicy) {
    const scope = sandbox.scopePolicy;
    lines.push("", `Scope limits per turn: ${scope.max_tool_calls} tool calls, ${scope.max_minutes} wall minutes, ${scope.max_files_changed} distinct observed changed paths and ${scope.max_bytes_written} observed written bytes in brain, scratch and workspaces.`,
      "One finite Continue grant per dimension adds its original cap. A second hit and the free-space floor max(5%, 2 GiB) allow Stop only. Voice stops without a grant. Observations cannot capture writes overwritten between snapshots.",
      ...(resolvedFacts.hardTimeoutMs === undefined ? [] : [`The independent host hard timeout is ${resolvedFacts.hardTimeoutMs / 60_000} minutes, including paused time. Resource and storage limits remain binding.`]));
  }
  const limits = resolvedFacts.limits ?? [];
  if (limits.length) lines.push("", "Limits in this turn:", ...limits.map(limit => `- **${limit.name}: ${limit.value}.** ${limit.onHit}`));
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
