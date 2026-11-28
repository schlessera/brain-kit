/** Hosted operational state never belongs in the agent-writable brain (#1649). */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { mountPointsUnder, workerIdentityHelper } from "@schlessera/brain-ui-sdk/internal";
import type { GovernedUnavailableReason } from "@schlessera/brain-ui-sdk/protocol";
import { journalDatabasePath } from "../db/journal-database.js";

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
/**
 * A deny check, under the deny-direction rule (#3422): a brain at `/` holds
 * every absolute path, so all state counts as inside it.
 */
export const within = (root: string, path: string) => isWithin(root, path, { trailingSeparator: "boundary" });

/** An outside name does not move an inode out of the brain if another name or a bind mount remains there. */
type AliasScan = { scans: number; entries: number };
function hasBrainAlias(brain: string, path: string, descendants: boolean, counts?: AliasScan): boolean {
  if (counts) counts.scans++;
  let state = lstatSync(path, { throwIfNoEntry: false });
  const existing = Boolean(state);
  while (!state && path !== "/") { path = dirname(path); state = lstatSync(path, { throwIfNoEntry: false }); }
  if (!state || (!state.isFile() && !state.isDirectory())) return false;
  const mounted = mountPointsUnder(brain).length > 0;
  const identities = new Set<string>();
  const identity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`;
  if (mounted || (state.isFile() && state.nlink > 1)) identities.add(identity(state));
  const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let entries = 0;
  function collect(fd: number, depth: number): void {
    if (depth > 256) throw new Error("Operational state alias verification exceeds the directory depth bound");
    for (const name of readdirSync(`/proc/self/fd/${fd}`, { encoding: "buffer" })) {
      if (counts) counts.entries++;
      if (++entries > 200_000) throw new Error("Operational state alias verification exceeds 200000 entries");
      const entry = Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
      const info = lstatSync(entry);
      if (mounted || (!info.isDirectory() && info.nlink > 1)) identities.add(identity(info));
      if (info.isDirectory()) {
        const child = openSync(entry, directory);
        try {
          const held = fstatSync(child);
          if (held.dev !== info.dev || held.ino !== info.ino) throw new Error("Operational state alias directory changed before open");
          collect(child, depth + 1);
        } finally { closeSync(child); }
      }
    }
  }
  // Only the named private storage is recursive. Its configured parent is
  // checked by identity without traversing unrelated host siblings.
  if (descendants && existing && state.isDirectory()) {
    const fd = openSync(path, directory);
    try {
      const held = fstatSync(fd);
      if (held.dev !== state.dev || held.ino !== state.ino) throw new Error("Operational state alias directory changed before open");
      collect(fd, 0);
    } finally { closeSync(fd); }
  }
  if (!identities.size) return false;
  entries = 0;
  function walk(fd: number, depth: number): boolean {
    if (depth > 256) throw new Error("Operational state alias verification exceeds the directory depth bound");
    for (const name of readdirSync(`/proc/self/fd/${fd}`, { encoding: "buffer" })) {
      if (counts) counts.entries++;
      if (++entries > 200_000) throw new Error("Operational state alias verification exceeds 200000 entries");
      const entry = Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
      const info = lstatSync(entry);
      if (identities.has(identity(info))) return true;
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
    return identities.has(identity(root)) || walk(fd, 0);
  } finally { closeSync(fd); }
}

export interface OperationalStateLayout {
  brainPath: string;
  dbPath?: string;
  privateStatePaths?: readonly { setting: string; path: string }[];
}
/** What the server and cron both derive the private-state layout from (#4498). */
export interface PrivateStateLayoutInput {
  /** `DB_PATH`; `""` and `:memory:` are ephemeral. */
  dbPath: string;
  /** `BRAIN_UI_NATIVE_BRAIN_LEASE_PATH`, when configured. */
  nativeLeasePath?: string;
  /** `BRAIN_UI_INBOX_POKE_TOKEN_FILE`, when configured. */
  pokeTokenFile?: string | null;
  /** Resolved compute settings (`resolveComputeConfig`). */
  compute: { keys: Readonly<Record<string, readonly string[]>>; stateDir: string | null };
  /**
   * The server's fresh temporary journal directory for an ephemeral
   * database. Cron cannot share it and does not check it.
   */
  ephemeralJournalRoot?: string;
}

export interface PrivateStateLayout {
  ephemeral: boolean;
  nativeLeasePath: string;
  /** Absent for an ephemeral database without a supplied journal root. */
  journalRoot?: string;
  /** The compute state directory, only when compute is configured. */
  computeStateDir?: string;
  privateStatePaths: { setting: string; path: string }[];
}

/**
 * The one derivation of `privateStatePaths` for the server, both cron entry
 * points and cron module discovery (#4498). Reads only whether an existing
 * compute state directory is present; creates nothing.
 */
export function privateStateLayout(input: PrivateStateLayoutInput): PrivateStateLayout {
  const ephemeral = input.dbPath === "" || input.dbPath === ":memory:";
  const nativeLeasePath = resolve(input.nativeLeasePath ?? `${input.dbPath}.native-leases.sqlite`);
  const journalRoot = ephemeral ? input.ephemeralJournalRoot
    : join(dirname(resolve(input.dbPath)), `${basename(input.dbPath)}.journal`);
  const privateStatePaths = input.pokeTokenFile ? [{ setting: "BRAIN_UI_INBOX_POKE_TOKEN_FILE", path: input.pokeTokenFile }] : [];
  if (journalRoot) privateStatePaths.push({ setting: "Storage transfer cache", path: `${journalRoot}.storage-cache` }, { setting: "turn journal", path: journalRoot });
  privateStatePaths.push({ setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: nativeLeasePath });
  // The host web executor's per-session private directories (#3686): host
  // operational state beside the journal, refused inside the brain and masked
  // from workers like the rest.
  if (journalRoot) privateStatePaths.push({ setting: "web executor state", path: `${journalRoot}.web-executor` });
  // Hosted external compute state (#3108, ruling R5): host operational state
  // beside the database. An unconfigured host (no bound credential, no
  // earlier state) has none, so it boots exactly as before hosted compute.
  const { stateDir } = input.compute;
  const computeConfigured = Object.keys(input.compute.keys).length > 0 || (stateDir !== null && existsSync(stateDir));
  const computeStateDir = stateDir && computeConfigured ? stateDir : undefined;
  if (computeStateDir) privateStatePaths.push({ setting: "BRAIN_UI_COMPUTE_STATE_DIR", path: computeStateDir });
  return { ephemeral, nativeLeasePath, ...(journalRoot ? { journalRoot } : {}), ...(computeStateDir ? { computeStateDir } : {}), privateStatePaths };
}

/** Include real SQLite sidecars and the separately derived quarantine location. */
type StatePath = { setting: string; path: string | (() => string) };
const statePath = (entry: StatePath): string => typeof entry.path === "string" ? entry.path : entry.path();
function statePaths(input: OperationalStateLayout): StatePath[] {
  const database = input.dbPath && input.dbPath !== ":memory:" ? input.dbPath : undefined;
  return [...(database ? [{ setting: "DB_PATH", path: database }, ...["-wal", "-shm"].map(suffix => ({ setting: "DB_PATH", path: () => `${canonical(database)}${suffix}` }))] : []),
    // The journal's own database file and its sidecars (#2789).
    ...(database ? ["", "-wal", "-shm"].map(suffix => ({ setting: "DB_PATH", path: () => canonical(`${journalDatabasePath(input.dbPath!)}${suffix}`) })) : []),
    ...(input.dbPath === ":memory:" ? [{ setting: "TMPDIR", path: `${tmpdir()}/brain-ui-quarantine` }] : []),
    ...(input.dbPath !== undefined && input.dbPath !== ":memory:" ? [{ setting: "DB_PATH quarantine", path: join(dirname(resolve(input.dbPath)), "brain-ui-quarantine") }] : []),
    ...(input.privateStatePaths ?? [])];
}

/** Every state path of a layout, resolved now: the roots launch qualification judges (#4301). */
export function operationalStatePaths(input: OperationalStateLayout): { setting: string; path: string }[] {
  return statePaths(input).map(entry => ({ setting: entry.setting, path: statePath(entry) }));
}

/** Keep the configured directory masks and also cover resolved targets and private siblings. */
export function operationalStateMasks(input: OperationalStateLayout): string[] {
  const masks = new Set<string>();
  for (const entry of statePaths(input)) {
    const path = statePath(entry);
    masks.add(canonical(dirname(path)));
    masks.add(dirname(canonical(path)));
    if (lstatSync(canonical(path), { throwIfNoEntry: false })?.isDirectory()) masks.add(canonical(path));
  }
  return [...masks];
}

interface OperationalStateRefusal {
  available: false;
  reason: GovernedUnavailableReason;
  detail: string;
  /** Internal cause; non-enumerable so availability/status retain their wire shape. */
  cause?: unknown;
}

/** Check one path; another path's incomplete scan cannot hide a confirmed exposure. */
function checkOperationalPath(brain: string, entry: StatePath, counts?: AliasScan): OperationalStateRefusal | undefined {
  const { setting } = entry, path = statePath(entry);
  // Both the state file and its directory matter: sibling WAL/quarantine data
  // share that directory, while a file itself can be a link into the brain.
  const resolved = canonical(path);
  const location = within(brain, resolved) || within(brain, canonical(dirname(path))) ? "resolves inside"
    : hasBrainAlias(brain, resolved, true, counts) || hasBrainAlias(brain, canonical(dirname(path)), false, counts)
      || hasBrainAlias(brain, dirname(resolved), false, counts) ? "has an inode alias inside" : undefined;
  if (location) {
    return { available: false, reason: setting === "DB_PATH" ? "database_in_brain" : "private_state_in_brain",
      detail: `OperationalStateInBrainError: ${setting} ${location} the brain; stop the server, move the state directory outside the brain (including database WAL/SHM and quarantine siblings), remove any state aliases from the brain, point ${setting === "DB_PATH quarantine" ? "DB_PATH" : setting} at the moved path, then restart. Do not remove the worker masks.` };
  }
}

function unverified(cause: unknown): OperationalStateRefusal {
  return Object.defineProperty({ available: false as const, reason: "private_state_unverified" as const,
    detail: `OperationalStateAliasVerificationUnavailable: ${cause instanceof Error ? cause.message : String(cause)}; boot or turn admission is refused until a later check can verify private state.` }, "cause", { value: cause });
}

/** Retry each complete identity comparison, including destinations already visited. */
export function operationalStateRefusal(input: OperationalStateLayout, counts?: AliasScan): OperationalStateRefusal | undefined {
  let brain: string;
  try { brain = canonical(input.brainPath); } catch (error) { return unverified(error); }
  let incomplete: OperationalStateRefusal | undefined;
  for (const entry of statePaths(input)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const refusal = checkOperationalPath(brain, entry, counts);
        if (refusal) return refusal;
        break;
      } catch (error) { if (attempt === 2) incomplete ??= unverified(error); }
    }
  }
  return incomplete;
}

/** Refuse before opening state, reconciling manifests or evaluating any brain code. */
export function assertOperationalStateOutsideBrain(input: OperationalStateLayout): void {
  const refusal = operationalStateRefusal(input);
  if (!refusal) return;
  const error = new Error(refusal.detail, refusal.reason === "private_state_unverified" ? { cause: refusal.cause } : undefined);
  error.name = refusal.reason === "private_state_unverified" ? "OperationalStateAliasVerificationUnavailable" : "OperationalStateInBrainError";
  // An embedder can show the same diagnostic even though a refused app has no HTTP listener.
  throw Object.assign(error, { status: refusal });
}

/** Concrete host state used only by the server's existing worker identity probe. */
export interface WorkerProbeState extends Omit<OperationalStateLayout, "brainPath"> {
  /** @internal Already selected by createApp; revalidated before each probe. */
  identitySentinelDirectory?: string;
}

/** Never place a helper's private proof input in a checkpointable brain. */
export function workerIdentitySentinelDirectory(brainPath: string, state: WorkerProbeState = {}): string | undefined {
  if (!workerIdentityHelper()) return undefined;
  const selected = state.identitySentinelDirectory
    ?? (state.dbPath && state.dbPath !== ":memory:" ? dirname(canonical(state.dbPath))
      : (() => {
        const lease = state.privateStatePaths?.find(entry => entry.setting === "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH");
        return lease ? dirname(canonical(lease.path)) : undefined;
      })());
  if (!selected) throw new Error("Worker identity qualification requires trusted server state outside the brain");
  const directory = canonical(selected);
  if (!lstatSync(directory).isDirectory()) throw new Error("Worker identity qualification requires an existing server state directory");
  assertOperationalStateOutsideBrain({ brainPath, privateStatePaths: [
    { setting: "worker identity sentinel", path: join(directory, ".worker-identity-probe") },
  ] });
  return directory;
}
