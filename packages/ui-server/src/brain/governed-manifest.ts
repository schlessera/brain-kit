/**
 * The durable protected-path manifest of a governed turn, and the quarantine
 * that reconciles against it (#1648; docs/decisions/governed-writable-workers.md,
 * "Protected paths", steps 1–4).
 *
 * A protected name that is absent when a turn starts cannot be mounted
 * read-only without creating it, so a turn can create one: a `brain.config.ts`,
 * a `bunfig.toml` preload, an `.mcp.json`, a new `.env`. Before the turn's
 * worker launches, the server records which protected paths exist, with their
 * identity and bytes. When the turn ends, or at the next boot if the server
 * died mid-turn, anything protected that appeared during the turn is moved
 * into a host-private quarantine beside the UI database and removed from the
 * brain, before any maintenance worker or later turn can evaluate it.
 *
 * Nothing here follows a link: each path is reached through directory
 * descriptors opened with `O_NOFOLLOW`, and an ancestor that stopped being a
 * real directory is itself what gets quarantined.
 */
import type { Database } from "bun:sqlite";
import {
  closeSync, constants, cpSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import { isEnvName, protectedPaths } from "@schlessera/brain-ui-sdk/internal";
import { processAlive, SELF } from "./writer-gate.js";

/** One protected path as it stood. `blocked`: an ancestor was not a real directory, named here. */
export interface ManifestEntry {
  path: string;
  exists: boolean;
  type?: "file" | "directory" | "symlink" | "other";
  dev?: number;
  ino?: number;
  /** sha256 of a regular file's bytes, up to {@link HASH_LIMIT}; past it, the size. */
  hash?: string;
  blocked?: string;
}

export interface TurnManifest {
  /** The protected list this turn ran under. */
  protected: string[];
  entries: ManifestEntry[];
  /** The `.env*` names at the brain root. */
  env: string[];
}

export interface Reconciliation {
  turnId: string;
  /** Brain-relative paths moved out of the brain, and where to. */
  quarantined: { path: string; to: string }[];
  /** Protected paths that existed at the start and differ now. Read-only mounts make this unexpected; it is reported, not moved. */
  changed: string[];
  /** Paths that could not be moved, with why. */
  failed: { path: string; error: string }[];
}

const HASH_LIMIT = 16 * 1024 * 1024;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

function kind(info: import("node:fs").Stats): ManifestEntry["type"] {
  return info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other";
}

function hashFile(path: string, size: number): string {
  if (size > HASH_LIMIT) return `size:${size}`;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return "unreadable";
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

/**
 * Opens the real directories leading to `rel`'s parent, without following a
 * link. Returns the descriptor chain, or the first ancestor that is not a real
 * directory (or is missing, `null`).
 */
function walk(root: string, rel: string): { fds: number[] } | { stop: string; missing: boolean } {
  const fds = [openSync(root, DIRECTORY)];
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    try { fds.push(openSync(at(fds.at(-1)!, parts[i]!), DIRECTORY)); }
    catch (error) {
      for (const fd of fds.reverse()) closeSync(fd);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { stop: parts.slice(0, i + 1).join("/"), missing: true };
      if (code === "ELOOP" || code === "ENOTDIR") return { stop: parts.slice(0, i + 1).join("/"), missing: false };
      throw error;
    }
  }
  return { fds };
}

function inspect(root: string, rel: string): ManifestEntry {
  const chain = walk(root, rel);
  if (!("fds" in chain)) return chain.missing ? { path: rel, exists: false } : { path: rel, exists: false, blocked: chain.stop };
  try {
    const target = at(chain.fds.at(-1)!, rel.split("/").at(-1)!);
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (!info) return { path: rel, exists: false };
    const entry: ManifestEntry = { path: rel, exists: true, type: kind(info), dev: info.dev, ino: info.ino };
    if (info.isFile()) entry.hash = hashFile(target, info.size);
    return entry;
  } finally { for (const fd of chain.fds.reverse()) closeSync(fd); }
}

function envNames(root: string): string[] {
  return readdirSync(root).filter(isEnvName).sort();
}

/** The manifest of a brain as it stands now. */
export function takeManifest(brainPath: string, paths: readonly string[] = protectedPaths()): TurnManifest {
  const root = realpathSync(brainPath);
  return { protected: [...paths], entries: paths.map(path => inspect(root, path)), env: envNames(root) };
}

function sameIdentity(before: ManifestEntry, now: ManifestEntry): boolean {
  return before.exists === now.exists && before.type === now.type && before.dev === now.dev && before.ino === now.ino && before.hash === now.hash;
}

/**
 * What appeared since `start`: protected paths and `.env*` names that were
 * absent then and are present now, and ancestors that stopped being real
 * directories (an ancestor swapped for a link would redirect the protected
 * path below it). Brain-relative; ancestors before their descendants.
 */
export function appearedSince(brainPath: string, start: TurnManifest): { appeared: string[]; changed: string[] } {
  const now = takeManifest(brainPath, start.protected);
  const appeared = new Set<string>();
  const changed: string[] = [];
  start.entries.forEach((before, i) => {
    const current = now.entries[i]!;
    if (current.blocked && before.blocked !== current.blocked) appeared.add(current.blocked);
    else if (!before.exists && current.exists) appeared.add(current.path);
    else if (before.exists && !sameIdentity(before, current)) changed.push(current.path);
  });
  for (const name of now.env) if (!start.env.includes(name)) appeared.add(name);
  // A quarantined ancestor takes everything below it along.
  const sorted = [...appeared].sort((a, b) => a.length - b.length);
  return { appeared: sorted.filter((path, i) => !sorted.slice(0, i).some(parent => path.startsWith(`${parent}/`))), changed };
}

/** Moves `rel` out of the brain into `destination`, through its parent's descriptor. */
function moveOut(root: string, rel: string, destination: string): void {
  const chain = walk(root, rel);
  if (!("fds" in chain)) throw new Error(`its parent ${chain.stop} is not a real directory`);
  try {
    const source = at(chain.fds.at(-1)!, rel.split("/").at(-1)!);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    try { renameSync(source, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // Another filesystem: copy without following links, then remove.
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      rmSync(source, { recursive: true, force: true });
    }
  } finally { for (const fd of chain.fds.reverse()) closeSync(fd); }
}

/**
 * Refuses when a reconciliation left a protected path in the brain: boot and
 * the cron runner stop there rather than let anything evaluate it. The
 * operator removes the named paths; the next start reconciles again.
 */
export function assertReconciled(results: readonly Reconciliation[]): void {
  const failed = results.flatMap(result => result.failed.map(f => `${f.path} (turn ${result.turnId}: ${f.error})`));
  if (failed.length) {
    throw new Error(`A governed turn left protected paths in the brain that could not be quarantined: ${failed.join("; ")}. `
      + "Remove them from the brain, then start again; nothing evaluates the brain until they are gone.");
  }
}

export interface GovernedManifests {
  /** Records the manifest durably. Call before the turn's worker launches. */
  begin(turnId: string, paths?: readonly string[]): TurnManifest;
  /** Quarantines what the turn left and closes its record. */
  end(turnId: string): Reconciliation;
  /** At boot: every turn with a manifest, no end record and no live server is reconciled. */
  reconcileAbandoned(): Reconciliation[];
  /** Whether a governed turn has ever started on this brain. */
  hasHistory(): boolean;
  /** Protected names present now that are absent from the start manifest of a turn still running. */
  appearedDuringActiveTurns(): string[];
}

export function createGovernedManifests(db: Database, options: { brainPath: string; quarantineDir: string; log?: Logger; now?: () => number }): GovernedManifests {
  let root: string;
  try { root = realpathSync(options.brainPath); } catch { root = resolve(options.brainPath); }
  const now = options.now ?? Date.now;
  const quarantine = (turnId: string, start: TurnManifest): Reconciliation => {
    const result: Reconciliation = { turnId, quarantined: [], changed: [], failed: [] };
    let found: ReturnType<typeof appearedSince>;
    try { found = appearedSince(root, start); }
    catch (error) {
      result.failed.push({ path: ".", error: error instanceof Error ? error.message : String(error) });
      return result;
    }
    result.changed = found.changed;
    for (const path of found.appeared) {
      let to = join(options.quarantineDir, turnId, path);
      for (let n = 1; lstatSync(to, { throwIfNoEntry: false }); n++) to = join(options.quarantineDir, turnId, `${path}.${n}`);
      try {
        mkdirSync(options.quarantineDir, { recursive: true, mode: 0o700 });
        moveOut(root, path, to);
        result.quarantined.push({ path, to });
      } catch (error) {
        result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (result.quarantined.length || result.changed.length || result.failed.length) {
      options.log?.emit({
        severityText: result.failed.length ? "ERROR" : "WARN",
        body: `governed turn ${turnId}: quarantined ${result.quarantined.length} protected path(s) that appeared during the turn`
          + (result.changed.length ? `; ${result.changed.length} existing protected path(s) changed` : "")
          + (result.failed.length ? `; ${result.failed.length} could not be moved` : ""),
        attributes: { "governance.event": "quarantine", "turn.id": turnId,
          "governance.quarantined": result.quarantined.map(q => q.path).join(","),
          "governance.changed": result.changed.join(","), "governance.failed": result.failed.map(f => f.path).join(",") },
      });
    }
    return result;
  };
  const close = (turnId: string, manifest: string): Reconciliation => {
    const result = quarantine(turnId, JSON.parse(manifest) as TurnManifest);
    // A path that could not be moved keeps the record open: the next
    // reconciliation tries again, and until then nothing may evaluate the
    // brain (`assertReconciled`).
    db.query("UPDATE governed_turn_manifests SET ended_at = ?, reconciliation = ? WHERE turn_id = ?")
      .run(result.failed.length ? null : now(), JSON.stringify(result), turnId);
    return result;
  };
  return {
    begin(turnId, paths) {
      const manifest = takeManifest(root, paths);
      db.query("INSERT INTO governed_turn_manifests (turn_id, brain, pid, pid_start, manifest, started_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(turnId, root, SELF.pid, SELF.start, JSON.stringify(manifest), now());
      return manifest;
    },
    end(turnId) {
      const row = db.query("SELECT manifest FROM governed_turn_manifests WHERE turn_id = ? AND brain = ? AND ended_at IS NULL")
        .get(turnId, root) as { manifest: string } | null;
      if (!row) throw new Error(`no open governed manifest for turn ${turnId}`);
      return close(turnId, row.manifest);
    },
    reconcileAbandoned() {
      const rows = db.query("SELECT turn_id, pid, pid_start, manifest, reconciliation FROM governed_turn_manifests WHERE brain = ? AND ended_at IS NULL ORDER BY started_at")
        .all(root) as { turn_id: string; pid: number; pid_start: string; manifest: string; reconciliation: string | null }[];
      // A turn whose server died, and any turn that already ended with a path
      // it could not move: that turn is over whoever owns it, and is retried
      // (and refused while it fails) by every process that reconciles.
      return rows.filter(row => row.reconciliation !== null
          || (!(row.pid === SELF.pid && row.pid_start === SELF.start) && !processAlive(row.pid, row.pid_start)))
        .map(row => close(row.turn_id, row.manifest));
    },
    hasHistory() {
      return db.query("SELECT 1 FROM governed_turn_manifests WHERE brain = ? LIMIT 1").get(root) !== null;
    },
    appearedDuringActiveTurns() {
      const rows = db.query("SELECT pid, pid_start, manifest FROM governed_turn_manifests WHERE brain = ? AND ended_at IS NULL")
        .all(root) as { pid: number; pid_start: string; manifest: string }[];
      const names = new Set<string>();
      for (const row of rows) {
        if (!processAlive(row.pid, row.pid_start)) continue;
        for (const path of appearedSince(root, JSON.parse(row.manifest) as TurnManifest).appeared) names.add(path);
      }
      return [...names].sort();
    },
  };
}
