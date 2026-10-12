/** Hosted operational state never belongs in the agent-writable brain (#1649). */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { mountPointsUnder } from "@schlessera/brain-ui-sdk/internal";
import type { GovernedUnavailableReason } from "@schlessera/brain-ui-sdk/protocol";

/** Follow filesystem components in order: link/.. must traverse the link first. */
function canonical(path: string, links = 0): string {
  if (links > 40) throw new Error("Operational state path has too many symbolic links");
  const parts = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split("/");
  let current = "/";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    let info;
    try { info = lstatSync(next); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (info?.isSymbolicLink()) {
      const target = readlinkSync(next);
      // Keep both the target and remaining components unnormalized. This
      // also handles dangling links selecting a not-yet-created database.
      return canonical(`${isAbsolute(target) ? target : `${current}/${target}`}/${parts.slice(i + 1).join("/")}`, links + 1);
    }
    current = next;
  }
  return current;
}
const within = (root: string, path: string) => root === "/" || path === root || path.startsWith(`${root}/`);

/** An outside name does not move an inode out of the brain if another name or a bind mount remains there. */
function hasBrainAlias(brain: string, path: string): boolean {
  let state = lstatSync(path, { throwIfNoEntry: false });
  while (!state && path !== "/") { path = dirname(path); state = lstatSync(path, { throwIfNoEntry: false }); }
  if (!state || (!state.isFile() && !state.isDirectory())) return false;
  if ((!state.isFile() || state.nlink <= 1) && mountPointsUnder(brain).length === 0) return false;
  const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let entries = 0;
  function walk(fd: number, depth: number): boolean {
    if (depth > 256) throw new Error("Operational state alias verification exceeds the directory depth bound");
    for (const name of readdirSync(`/proc/self/fd/${fd}`, { encoding: "buffer" })) {
      if (++entries > 200_000) throw new Error("Operational state alias verification exceeds 200000 entries");
      const entry = Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
      const info = lstatSync(entry);
      if (info.dev === state!.dev && info.ino === state!.ino) return true;
      if (info.isDirectory()) {
        const child = openSync(entry, directory);
        try {
          const opened = fstatSync(child);
          if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("Operational state alias directory changed before open");
          if (walk(child, depth + 1)) return true;
        } finally { closeSync(child); }
      }
    }
    return false;
  }
  let fd: number;
  try { fd = openSync(brain, directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const root = fstatSync(fd);
    return (root.dev === state.dev && root.ino === state.ino) || walk(fd, 0);
  } finally { closeSync(fd); }
}

export interface OperationalStateLayout {
  brainPath: string;
  dbPath?: string;
  privateStatePaths?: readonly { setting: string; path: string }[];
}
/** Include real SQLite sidecars and the separately derived quarantine location. */
function statePaths(input: OperationalStateLayout): { setting: string; path: string }[] {
  const database = input.dbPath && input.dbPath !== ":memory:" ? canonical(input.dbPath) : undefined;
  return [...(database ? [input.dbPath!, `${database}-wal`, `${database}-shm`].map(path => ({ setting: "DB_PATH", path })) : []),
    ...(input.dbPath === ":memory:" ? [{ setting: "TMPDIR", path: `${tmpdir()}/brain-ui-quarantine` }] : []),
    ...(input.dbPath !== undefined && input.dbPath !== ":memory:" ? [{ setting: "DB_PATH quarantine", path: join(dirname(resolve(input.dbPath)), "brain-ui-quarantine") }] : []),
    ...(input.privateStatePaths ?? [])];
}

/** Keep the configured directory masks and also cover resolved targets and private siblings. */
export function operationalStateMasks(input: OperationalStateLayout): string[] {
  const masks = new Set<string>();
  for (const { path } of statePaths(input)) {
    masks.add(canonical(dirname(path)));
    masks.add(dirname(canonical(path)));
    if (lstatSync(canonical(path), { throwIfNoEntry: false })?.isDirectory()) masks.add(canonical(path));
  }
  return [...masks];
}

export interface OperationalStateRefusal {
  available: false;
  reason: GovernedUnavailableReason;
  detail: string;
}

/** The boot check and status surface share the exact resolution and migration guidance. */
export function operationalStateRefusal(input: OperationalStateLayout): OperationalStateRefusal | undefined {
  const brain = canonical(input.brainPath);
  const paths = statePaths(input);
  for (const { setting, path } of paths) {
    // Both the state file and its directory matter: sibling WAL/quarantine data
    // share that directory, while a file itself can be a link into the brain.
    const resolved = canonical(path);
    const location = within(brain, resolved) || within(brain, canonical(dirname(path))) ? "resolves inside"
      : hasBrainAlias(brain, resolved) || hasBrainAlias(brain, canonical(dirname(path)))
        || hasBrainAlias(brain, dirname(resolved)) ? "has an inode alias inside" : undefined;
    if (location) {
      return { available: false, reason: setting === "DB_PATH" ? "database_in_brain" : "private_state_in_brain",
        detail: `OperationalStateInBrainError: ${setting} ${location} the brain; stop the server, move the state directory outside the brain (including database WAL/SHM and quarantine siblings), remove any state aliases from the brain, point ${setting === "DB_PATH quarantine" ? "DB_PATH" : setting} at the moved path, then restart. Do not remove the worker masks.` };
    }
  }
}

/** Refuse before opening state, reconciling manifests or evaluating any brain code. */
export function assertOperationalStateOutsideBrain(input: OperationalStateLayout): void {
  const refusal = operationalStateRefusal(input);
  if (!refusal) return;
  const error = new Error(refusal.detail);
  error.name = "OperationalStateInBrainError";
  // An embedder can show the same diagnostic even though a refused app has no HTTP listener.
  throw Object.assign(error, { status: refusal });
}
