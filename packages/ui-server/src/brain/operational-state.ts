/** Hosted operational state never belongs in the agent-writable brain (#1649). */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readFileSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
function hasBrainAlias(brain: string, path: string, descendants = false, mounted = mountPointsUnder(brain).length > 0): boolean {
  let state = lstatSync(path, { throwIfNoEntry: false });
  const existing = Boolean(state);
  while (!state && path !== "/") { path = dirname(path); state = lstatSync(path, { throwIfNoEntry: false }); }
  if (!state || (!state.isFile() && !state.isDirectory())) return false;
  const identities = new Set<string>();
  const identity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`;
  if (mounted || (state.isFile() && state.nlink > 1)) identities.add(identity(state));
  const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let entries = 0;
  function collect(fd: number, depth: number): void {
    if (depth > 256) throw new Error("Operational state alias verification exceeds the directory depth bound");
    for (const name of readdirSync(`/proc/self/fd/${fd}`, { encoding: "buffer" })) {
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
/** Include real SQLite sidecars and the separately derived quarantine location. */
function statePaths(input: OperationalStateLayout): { setting: string; path: string }[] {
  const database = input.dbPath && input.dbPath !== ":memory:" ? canonical(input.dbPath) : undefined;
  return [...(database ? [input.dbPath!, `${database}-wal`, `${database}-shm`].map(path => ({ setting: "DB_PATH", path })) : []),
    // The journal's own database file and its sidecars (#2789).
    ...(database ? ["", "-wal", "-shm"].map(suffix => ({ setting: "DB_PATH", path: canonical(`${journalDatabasePath(input.dbPath!)}${suffix}`) })) : []),
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

interface OperationalStateRefusal {
  available: false;
  reason: GovernedUnavailableReason;
  detail: string;
}

/** The boot check and status surface share the exact resolution and migration guidance. */
function inspectOperationalState(input: OperationalStateLayout, boundary = false, mounted?: boolean): OperationalStateRefusal | undefined {
  const brain = canonical(input.brainPath);
  const paths = statePaths(input);
  for (const { setting, path } of paths) {
    // Both the state file and its directory matter: sibling WAL/quarantine data
    // share that directory, while a file itself can be a link into the brain.
    const resolved = canonical(path);
    const location = within(brain, resolved) || within(brain, canonical(dirname(path))) ? "resolves inside"
      : !boundary && (hasBrainAlias(brain, resolved, true, mounted) || hasBrainAlias(brain, canonical(dirname(path)), false, mounted)
        || hasBrainAlias(brain, dirname(resolved), false, mounted)) ? "has an inode alias inside" : undefined;
    if (location) {
      return { available: false, reason: setting === "DB_PATH" ? "database_in_brain" : "private_state_in_brain",
        detail: `OperationalStateInBrainError: ${setting} ${location} the brain; stop the server, move the state directory outside the brain (including database WAL/SHM and quarantine siblings), remove any state aliases from the brain, point ${setting === "DB_PATH quarantine" ? "DB_PATH" : setting} at the moved path, then restart. Do not remove the worker masks.` };
    }
  }
}

/** The public full guard never accepts a caller-supplied boundary exemption. */
export function operationalStateRefusal(input: OperationalStateLayout): OperationalStateRefusal | undefined {
  return inspectOperationalState(input);
}

/** Concrete kernel reads, shared by admission and its offline regression probes. */
export const operationalStateEvidence = {
  identity(path: string) {
    const info = lstatSync(path, { bigint: true });
    const fs = statfsSync(path, { bigint: true });
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw Error("State root identity is not regular");
    return { device: String(info.dev), inode: String(info.ino), owner: Number(info.uid), mode: Number(info.mode), type: String(fs.type) };
  },
  mounts: () => readFileSync("/proc/self/mountinfo", "utf8"),
};
export interface OperationalStateProof {
  mode: "filesystem_identity" | "walk";
  cause: string;
}
/**
 * Retain qualification inputs, never a passed shared-filesystem verdict. Every
 * call reads current root identities and one mount table before selecting proof.
 * Linux Btrfs getattr uses a distinct anonymous st_dev for each subvolume; no
 * transaction generation, timestamp or elapsed-time cache participates.
 */
export function createOperationalStateProof(record: (proof: OperationalStateProof) => void = () => {}) {
  let qualified: string | undefined, last: string | undefined;
  return (input: OperationalStateLayout): OperationalStateRefusal | undefined => {
    let signature: string | undefined, mounted: boolean | undefined;
    let cause = "state shares a filesystem or its boundary could not be read";
    try {
      const brain = canonical(input.brainPath), paths = statePaths(input);
      const roots = [...new Set(paths.flatMap(({ path }) => [canonical(path), canonical(dirname(path))]))];
      const existing = (path: string) => {
        while (!lstatSync(path, { throwIfNoEntry: false }) && path !== "/") path = dirname(path);
        return path;
      };
      const brainId = operationalStateEvidence.identity(brain);
      const identities = roots.map(path => [path, operationalStateEvidence.identity(existing(path))] as const);
      const table = operationalStateEvidence.mounts();
      const decode = (path: string) => path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      const rows = table.trim().split("\n").map(line => {
        const fields = line.split(" ");
        if (fields.length < 10 || !line.includes(" - ")) throw Error("Unreadable mount topology");
        return { path: decode(fields[4]!), root: decode(fields[3]!), device: fields[2]!, line };
      });
      mounted = rows.some(row => within(brain, row.path));
      // Conservatively requalify on any nested state/worker mount. A parent
      // bind can alias a state subtree too: compare kernel device/root names.
      const covering = (path: string) => rows.filter(row => within(row.path, path)).sort((a,b) => b.path.length-a.path.length)[0];
      const stateMounts = roots.map(path => {
        const row = covering(path);
        if (!row) throw Error("State mount identity missing");
        return { device: row.device, root: join(row.root, path.slice(row.path.length)) };
      });
      const masks = operationalStateMasks(input);
      const aliases = rows.some(row => stateMounts.some(state => {
        if (state.device !== row.device || !(within(state.root, row.root) || within(row.root, state.root))) return false;
        const exposed = within(row.root, state.root) ? join(row.path, state.root.slice(row.root.length)) : row.path;
        // Workers see the host RO except its masks. An alias elsewhere in that
        // host view can bypass the original mask just as a bind in the brain can.
        return within(brain, exposed) || !masks.some(mask => within(mask, exposed));
      }));
      const nested = rows.some(row => roots.some(root => within(root, row.path))) || rows.some(row => within(brain, row.path) && row.path !== brain);
      if (!nested && !aliases && identities.every(([, identity]) => identity.device !== brainId.device
        && [0, process.geteuid!()].includes(identity.owner) && !(identity.mode & 0o022))) {
        signature = JSON.stringify([brain, brainId, identities, input, rows.map(row => row.line)]);
        cause = "current filesystem/subvolume identities and mount topology prove separation";
      }
    } catch (error) { cause = `boundary evidence unavailable: ${String(error)}`; }
    const needsWalk = signature === undefined || signature !== qualified;
    const refusal = inspectOperationalState(input, !needsWalk, mounted);
    // Failed qualification never becomes a remembered boundary.
    qualified = refusal ? undefined : signature;
    const proof: OperationalStateProof = { mode: signature && !refusal ? "filesystem_identity" : "walk", cause: refusal?.detail ?? cause };
    const serialized = JSON.stringify(proof);
    if (serialized !== last) { record(proof); last = serialized; }
    return refusal;
  };
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
