/**
 * Explicit removal of one retired chat's native history (#3229), shared by
 * the first-party backends. Each backend names the exact artifacts it owns;
 * this module fences the session, waits for its holders and removes those
 * artifacts without following a link or touching anything else.
 * Policy: docs/decisions/chat-history-deletion.md.
 */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { BackendRequestError } from "./backend.js";
import type { SessionHistoryRemovalOutcome, SessionHistoryRemovalRequest, SessionHistoryRemovalResult } from "./backend.js";

const MAX_OPERATION = 2048;
const TOMBSTONE_BYTES = 4096;

/** Unknown dominates partial; removed only when every part was. */
export function combineRemovalOutcomes(outcomes: readonly SessionHistoryRemovalOutcome[]): SessionHistoryRemovalOutcome {
  if (outcomes.includes("unknown")) return "unknown";
  return outcomes.every(outcome => outcome === "removed") ? "removed" : "partial";
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
const realDirectory = (path: string) => {
  const info = lstatSync(path);
  return info.isDirectory() && realpathSync(path) === path;
};
/** Every entry below a directory is a plain file with one name or a real directory. */
function ownedTree(path: string): boolean {
  for (const name of readdirSync(path)) {
    const child = join(path, name), info = lstatSync(child);
    if (info.isDirectory()) { if (!ownedTree(child)) return false; }
    else if (!info.isFile() || info.nlink !== 1) return false;
  }
  return true;
}
function removeTree(path: string): void {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) removeTree(child);
    else unlinkSync(child);
  }
  syncDirectory(path);
  rmdirSync(path);
}

/**
 * Remove one owned file or directory tree at `root/name`. `removed` when it is
 * absent afterwards (already absent included); `partial`, touching nothing,
 * when the root is redirected or the artifact is a link, a hard-linked file, a
 * special file, or a tree containing any of these: its bytes could belong to,
 * or remain reachable through, something this chat does not own.
 */
export function removeOwnedArtifact(root: string, name: string): SessionHistoryRemovalOutcome {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("Invalid owned artifact name");
  if (!existsSync(root)) {
    // A missing root holds nothing, unless it is a dangling link.
    try { lstatSync(root); } catch { return "removed"; }
    return "partial";
  }
  if (!realDirectory(root)) return "partial";
  const path = join(root, name);
  let info;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "removed";
    throw error;
  }
  if (info.isDirectory()) {
    if (!ownedTree(path)) return "partial";
    removeTree(path);
  } else if (info.isFile() && info.nlink === 1) unlinkSync(path);
  else return "partial";
  syncDirectory(root);
  return "removed";
}

/** The names directly in `root` that `owned` selects; none for a missing root. */
export function ownedNames(root: string, owned: (name: string) => boolean): string[] {
  if (!existsSync(root) || !realDirectory(root)) return [];
  return readdirSync(root).filter(owned);
}

/** A host-owned metadata file and any temp copy its atomic writer left behind. */
export function removeMetadataFile(location: { dir: string; name: string }): SessionHistoryRemovalOutcome {
  const temps = ownedNames(location.dir, name => name.startsWith(`${location.name}.`) && name.endsWith(".tmp"));
  return combineRemovalOutcomes([location.name, ...temps].map(name => removeOwnedArtifact(location.dir, name)));
}

export interface SessionRetirementOptions {
  /**
   * Host-owned, content-free tombstones: one file per retired session, holding
   * only its operation identity. Resolved on use, so constructing a backend
   * never validates or creates its storage.
   */
  directory: () => string;
  /** The backend's own session-identity rule; a tombstone is named by it. */
  validSessionId: (id: string) => boolean;
}
export interface RemovalRun {
  /** Synchronous, after every holder has drained: no turn, reader or archive step interleaves with it. */
  remove(sessionId: string): SessionHistoryRemovalOutcome;
  /** Asks the installed runtime whether it still lists the session; a listed session is not removed. */
  stillListed(sessionId: string): Promise<boolean>;
  /** Drops in-memory runtime state (resident sessions, observation caches) once holders drained. */
  release?(sessionId: string): void | Promise<void>;
}

/**
 * The fence a backend consults on every list, read, resume, follow-up,
 * archive and restore path, and the single-flight removal behind it.
 * Durable: a tombstone written before anything is removed keeps refusing the
 * session after a restart, and a crash at any later boundary is reconciled by
 * repeating the same operation.
 */
export function createSessionRetirement(options: SessionRetirementOptions) {
  const retired = new Set<string>();
  const holders = new Map<string, { count: number; idle: Array<() => void> }>();
  const jobs = new Map<string, { operationId: string; done: Promise<SessionHistoryRemovalOutcome> }>();

  function tombstone(sessionId: string): string | undefined {
    let path: string;
    // Storage that cannot be resolved holds no tombstone; the in-memory fence still applies.
    try { path = join(options.directory(), sessionId); } catch { return undefined; }
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // Unreadable or aliased: still a fence, with no operation to match.
      return "";
    }
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > TOMBSTONE_BYTES) return "";
      return readFileSync(fd, "utf8");
    } catch { return ""; } finally { closeSync(fd); }
  }
  function isRetired(sessionId: string): boolean {
    if (retired.has(sessionId)) return true;
    if (!options.validSessionId(sessionId)) return false;
    if (tombstone(sessionId) === undefined) return false;
    retired.add(sessionId);
    return true;
  }
  function writeTombstone(sessionId: string, operationId: string): void {
    const root = options.directory();
    let missing = root;
    const create: string[] = [];
    while (!existsSync(missing)) { create.unshift(missing); missing = dirname(missing); }
    if (!realDirectory(missing)) throw new BackendRequestError("Chat retirement storage is redirected");
    for (const dir of create) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!realDirectory(dir)) throw new BackendRequestError("Chat retirement storage is redirected");
      syncDirectory(dirname(dir));
    }
    const fd = openSync(join(root, sessionId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, operationId); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(root);
  }
  function drained(sessionId: string): Promise<void> {
    const entry = holders.get(sessionId);
    return entry ? new Promise(resolve => entry.idle.push(resolve)) : Promise.resolve();
  }

  return {
    isRetired,
    /** For a list path: drop retired sessions, read after the list's own await. */
    filter<T extends { id: string }>(sessions: readonly T[]): T[] { return sessions.filter(session => !isRetired(session.id)); },
    /** Hold a session open for a turn or reader. Refuses a retired one; release once its last write or publication is done. */
    hold(sessionId: string): () => void {
      if (isRetired(sessionId)) throw new BackendRequestError(`Cannot resume unknown session: ${sessionId}`);
      const entry = holders.get(sessionId) ?? { count: 0, idle: [] };
      entry.count++; holders.set(sessionId, entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--entry.count > 0) return;
        holders.delete(sessionId);
        for (const resolve of entry.idle.splice(0)) resolve();
      };
    },
    async remove(req: SessionHistoryRemovalRequest, run: RemovalRun): Promise<SessionHistoryRemovalResult> {
      if (typeof req?.operationId !== "string" || !req.operationId || req.operationId.length > MAX_OPERATION ||
          typeof req.sessionId !== "string" || !options.validSessionId(req.sessionId))
        throw new BackendRequestError("Invalid session history removal request");
      const { operationId, sessionId } = req;
      let job = jobs.get(sessionId);
      if (job && job.operationId !== operationId) throw new BackendRequestError("Another removal owns this session");
      if (!job) {
        const recorded = tombstone(sessionId);
        if (recorded !== undefined && recorded !== operationId) throw new BackendRequestError("Another removal owns this session");
        // Fence first, synchronously: nothing admitted after this line can hold the session.
        retired.add(sessionId);
        if (recorded === undefined) writeTombstone(sessionId, operationId);
        const done = (async (): Promise<SessionHistoryRemovalOutcome> => {
          await drained(sessionId);
          try {
            await run.release?.(sessionId);
            const outcome = run.remove(sessionId);
            if (outcome !== "removed") return outcome;
            return await run.stillListed(sessionId) ? "partial" : "removed";
          } catch { return "unknown"; }
        })();
        job = { operationId, done };
        jobs.set(sessionId, job);
        const settled = job;
        void done.finally(() => { if (jobs.get(sessionId) === settled) jobs.delete(sessionId); });
      }
      const signal = req.signal;
      if (!signal) return { outcome: await job.done };
      if (signal.aborted) return { outcome: "partial" };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<SessionHistoryRemovalOutcome>(resolve => {
        onAbort = () => resolve("partial");
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return { outcome: await Promise.race([job.done, aborted]) }; }
      finally { signal.removeEventListener("abort", onAbort!); }
    },
  };
}
export type SessionRetirement = ReturnType<typeof createSessionRetirement>;
