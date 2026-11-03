/** Native Claude transcripts remain authoritative; this is their cold storage. */
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WorkerHostError, combineRemovalOutcomes, nativeObservationIdentity, ownedNames, removeMetadataFile, removeOwnedArtifact, sessionPromptContextLocation, sessionReplayLocation } from "@schlessera/brain-ui-sdk/internal";
import type { SessionHistoryRemovalOutcome } from "@schlessera/brain-ui-sdk/server";
import { envSnapshot } from "./config/env.js";
import { directory, files, isSessionId, regular, validateSessionId } from "./worker-state.js";

const DAY = 24 * 60 * 60 * 1000;
/** The archive's own manifest, index and marker files; not worker runtime state (#1625). */
const METADATA_BYTES = 16 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface ArchivedSession { id: string; title: string | null; createdAt: number; lastActiveAt: number }
interface Manifest { session: ArchivedSession; files: Array<{ path: string; hash: string }> }
export interface ArchiveOptions {
  brainPath: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  listSessionsFn?: typeof sdkListSessions;
  /** Read at deletion time, after awaiting SDK metadata. */
  activeSessionIds?: () => ReadonlySet<string>;
  log?: (message: string, error: unknown) => void;
  /** @internal Crash-injection seam at durable transaction boundaries. */
  checkpoint?: (phase: "archive" | "index" | "restore") => void;
}

export function transcriptPaths(brainPath: string, env: Record<string, string | undefined> = envSnapshot()) {
  const brain = existsSync(brainPath) ? realpathSync(brainPath) : resolve(brainPath);
  const config = resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
  if (config === brain || config.startsWith(`${brain}/`) || brain.startsWith(`${config}/`))
    throw new WorkerHostError("Claude transcripts must be outside the authoritative brain and its ancestors");
  // Read-only callers must not create a config tree just to list history.
  if (existsSync(config)) directory(config);
  const project = brain.replace(/[^a-zA-Z0-9]/g, "-");
  return { live: join(config, "projects", project), archive: join(config, "transcript-archive", project) };
}

/** Content-free tombstones of explicitly retired sessions (#3229); permanent. */
export function retiredDirectory(brainPath: string, env?: Record<string, string | undefined>): string {
  return join(transcriptPaths(brainPath, env).archive, "retired");
}
/** A tombstone, aliased or not, fences the session: archive and restore never touch it again. */
function retiredOnDisk(archive: string, id: string): boolean {
  try { lstatSync(join(archive, "retired", id)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableDirectory(path: string) {
  if (existsSync(path)) { directory(path); return; }
  durableDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(dirname(path));
}
function atomic(path: string, bytes: Uint8Array | string) {
  durableDirectory(dirname(path));
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    directory(dirname(path)); renameSync(temp, path); syncDirectory(dirname(path));
  } finally { rmSync(temp, { force: true }); }
}
/**
 * The same durable steps as `durableDirectory` and `atomic`, plus a staged
 * tree's directory syncs, waiting on the file system off the event loop: every turn's cleanup writes
 * the daily scan marker, and a loaded host's fsync must not stall the server
 * (#2416). The idle-session move uses them too (#2898); restore does not.
 */
async function syncTreeAsync(path: string): Promise<void> {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) await syncTreeAsync(child);
  }
  await syncDirectoryAsync(path);
}
async function syncDirectoryAsync(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableDirectoryAsync(path: string): Promise<void> {
  if (existsSync(path)) { directory(path); return; }
  await durableDirectoryAsync(dirname(path));
  // Native observations share this tree and may create a directory first.
  try { await mkdir(path, { mode: 0o700 }); }
  catch (created) { if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created; directory(path); }
  await syncDirectoryAsync(dirname(path));
}
async function atomicAsync(path: string, bytes: Uint8Array | string) {
  await durableDirectoryAsync(dirname(path));
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    directory(dirname(path)); await rename(temp, path); await syncDirectoryAsync(dirname(path));
  } finally { await rm(temp, { force: true }); }
}
function manifest(root: string, id: string): Manifest {
  directory(join(root, id));
  const value = JSON.parse(regular(join(root, id, "manifest.json"), METADATA_BYTES).toString()) as Manifest;
  if (value.session?.id !== id || !Array.isArray(value.files) || !value.files.every(f =>
    typeof f.path === "string" && (f.path === `${id}.jsonl` || f.path.startsWith(`${id}/`)) &&
    f.path.split("/").every(p => p !== ".." && p !== "." && p !== "" && !p.includes("\\")) &&
    typeof f.hash === "string")) throw new Error("Invalid transcript archive manifest");
  return value;
}
/** One unreadable entry never hides the rest of the archive; it is logged and skipped. */
function manifests(root: string, log?: ArchiveOptions["log"]): Manifest[] {
  if (!existsSync(root)) return [];
  directory(root);
  const result: Manifest[] = [];
  for (const id of readdirSync(root).filter(isSessionId)) {
    try { result.push(manifest(root, id)); }
    catch (error) { log?.(`Skipping unreadable transcript archive entry ${id}`, error); }
  }
  return result;
}
/** Counts synchronous index writes, so a sweep's asynchronous one that a restore or removal overtook is redone. */
const indexWrites = new Map<string, number>();
function index(root: string, entries: ArchivedSession[]) {
  indexWrites.set(root, (indexWrites.get(root) ?? 0) + 1);
  atomic(join(root, "index.json"), JSON.stringify(entries));
}
async function reindexAsync(root: string, log: ArchiveOptions["log"]) {
  for (;;) {
    const seen = indexWrites.get(root) ?? 0;
    await atomicAsync(join(root, "index.json"), JSON.stringify(manifests(root, log).map(m => m.session)));
    if ((indexWrites.get(root) ?? 0) === seen) return;
  }
}
function archivedBytes(root: string, id: string, file: Manifest["files"][number]): Uint8Array {
  const path = join(root, id, `${file.path}.gz`);
  directory(dirname(path));
  const bytes = Bun.gunzipSync(new Uint8Array(regular(path, Infinity)));
  if (digest(bytes) !== file.hash) throw new Error("Transcript archive checksum mismatch");
  return bytes;
}

/** A live transcript that differs from its archived copy is the newer one: keep
 * it in place, set the archived copy aside under a conflict name, reindex. */
function setAside(archive: string, id: string, options: ArchiveOptions) {
  renameSync(join(archive, id), asideName(archive, id, options)); syncDirectory(archive);
  index(archive, manifests(archive, options.log).map(m => m.session));
  setAsideLogged(id, options);
}
async function setAsideAsync(archive: string, id: string, options: ArchiveOptions) {
  renameSync(join(archive, id), asideName(archive, id, options)); await syncDirectoryAsync(archive);
  await reindexAsync(archive, options.log);
  setAsideLogged(id, options);
}
const asideName = (archive: string, id: string, options: ArchiveOptions) => join(archive, `.conflict-${id}-${options.now?.() ?? Date.now()}`);
function setAsideLogged(id: string, options: ArchiveOptions) {
  (options.log ?? ((message, reason) => console.warn(message, reason)))(
    `Transcript ${id} changed after it was archived; kept the live copy and set the archived one aside`, undefined);
}

/** Include committed manifests if a crash preceded the atomic index update. */
export function listArchivedSessions(options: ArchiveOptions): ArchivedSession[] {
  const { archive } = transcriptPaths(options.brainPath, options.env);
  const committed = manifests(archive, options.log).map(m => m.session);
  const indexPath = join(archive, "index.json");
  const entries: ArchivedSession[] = existsSync(indexPath) ? JSON.parse(regular(indexPath, METADATA_BYTES).toString()) : [];
  if (!Array.isArray(entries) || !entries.every(s => typeof s.id === "string" && isSessionId(s.id)))
    throw new Error("Invalid transcript archive index");
  return [...new Map([...entries, ...committed].map(s => [s.id, s])).values()];
}

/** Restore before history reads or worker snapshots. Synchronous: no turn can
 * start or archive between validation and publication in this backend process.
 * It stays so on purpose (#2898): the sweep's move awaits its fsyncs, and a
 * restore run in one of those windows is what its removal step rechecks for. */
export function restoreArchivedSession(id: string, options: ArchiveOptions): void {
  validateSessionId(id);
  const { live, archive } = transcriptPaths(options.brainPath, options.env);
  const source = join(archive, id);
  // A retired chat's archived copy is never restored, even if its removal has not finished.
  if (!existsSync(source) || retiredOnDisk(archive, id)) return;
  const record = manifest(archive, id);
  // Never overwrite a newer live version. Archiving only takes idle files, so
  // a live file that differs is the newer one: keep it in place, set the
  // archived copy aside under a conflict name, and never block the session.
  for (const file of record.files) {
    const target = join(live, file.path);
    if (existsSync(target)) {
      directory(dirname(target));
      if (digest(regular(target, Infinity)) !== file.hash) { setAside(archive, id, options); return; }
    }
    archivedBytes(archive, id, file);
  }
  atomic(join(source, "restoring"), "1");
  for (const file of record.files) {
    const target = join(live, file.path);
    atomic(target, archivedBytes(archive, id, file));
    const now = new Date(options.now?.() ?? Date.now());
    utimesSync(target, now, now);
  }
  options.checkpoint?.("restore");
  index(archive, manifests(archive, options.log).filter(m => m.session.id !== id).map(m => m.session));
  rmSync(source, { recursive: true }); syncDirectory(archive);
}

function sessionFiles(live: string, id: string): string[] {
  if (existsSync(live)) directory(live);
  const result = existsSync(join(live, `${id}.jsonl`)) ? [`${id}.jsonl`] : [];
  return [...result, ...files(join(live, id)).map(f => `${id}/${f}`)];
}
function newestMtime(path: string): number {
  const info = lstatSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  directory(path);
  return readdirSync(path).reduce((mtime, name) => Math.max(mtime, newestMtime(join(path, name))), info.mtimeMs);
}
function pruneEmpty(path: string) {
  if (!existsSync(path)) return;
  directory(path);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) pruneEmpty(child);
  }
  if (readdirSync(path).length === 0) rmdirSync(path);
}
/**
 * False, deleting nothing, when the live source changed after the archive copy
 * was taken; "skipped", deleting nothing, when while the sweep awaited a turn
 * took the session, or a restore, retirement or set-aside moved its archived
 * copy. That recheck, validation and deletion run as one synchronous step, so
 * nothing interleaves with them (#2898); both copies then stay for recovery.
 * The removed files' directories are synced after that step instead of after
 * each file: a crash in between leaves a subset, which recovery accepts.
 */
async function removeSource(live: string, archive: string, record: Manifest, options: ArchiveOptions): Promise<boolean | "skipped"> {
  const id = record.session.id;
  if (options.activeSessionIds?.().has(id) || retiredOnDisk(archive, id) ||
    !existsSync(join(archive, id)) || existsSync(join(archive, id, "restoring"))) return "skipped";
  // Validate the entire remaining source before deleting anything. A crash
  // during deletion leaves a subset, which the same check accepts on restart.
  const known = new Map(record.files.map(f => [f.path, f.hash]));
  const remaining = sessionFiles(live, id);
  for (const file of remaining) {
    if (digest(regular(join(live, file), Infinity)) !== known.get(file)) return false;
  }
  // Verify the durable copy even on recovery, before removing live bytes.
  for (const file of record.files) archivedBytes(archive, id, file);
  for (const file of remaining) rmSync(join(live, file));
  for (const parent of new Set(remaining.map(file => dirname(join(live, file))))) await syncDirectoryAsync(parent);
  pruneEmpty(join(live, id));
  if (existsSync(live)) await syncDirectoryAsync(live);
  return true;
}

/** Archives with a scan in flight in this process; a concurrent call skips. */
const scanning = new Set<string>();
/** Best effort, at most daily, and always outside the autonomous envelope. */
export async function archiveIdleSessions(options: ArchiveOptions): Promise<void> {
  let claimed: string | undefined;
  try {
    const { live, archive } = transcriptPaths(options.brainPath, options.env);
    if (!existsSync(live) && !existsSync(archive)) return;
    const now = options.now?.() ?? Date.now();
    const marker = join(archive, "last-scan");
    if (scanning.has(archive) || (existsSync(marker) && now - Number(regular(marker, METADATA_BYTES).toString()) < DAY)) return;
    // Claimed before the first wait, as the synchronous marker write was.
    scanning.add(archive); claimed = archive;
    await atomicAsync(marker, String(now));
    const sessions = await (options.listSessionsFn ?? sdkListSessions)({ dir: options.brainPath });
    const active = options.activeSessionIds?.() ?? new Set<string>();
    // Recovery precedes fresh moves. Committed manifests are immutable, so a
    // lost index write or partially removed source is safe to retry.
    for (const record of manifests(archive, options.log)) {
      if (active.has(record.session.id) || retiredOnDisk(archive, record.session.id)) continue;
      if (existsSync(join(archive, record.session.id, "restoring"))) {
        restoreArchivedSession(record.session.id, options);
      } else {
        await reindexAsync(archive, options.log);
        if (await removeSource(live, archive, record, options) === false) await setAsideAsync(archive, record.session.id, options);
      }
    }
    for (const session of sessions) {
      const id = session.sessionId;
      if (!isSessionId(id) || active.has(id) || existsSync(join(archive, id)) || retiredOnDisk(archive, id)) continue;
      const names = sessionFiles(live, id);
      if (!names.length) continue;
      const roots = [join(live, `${id}.jsonl`), join(live, id)].filter(existsSync);
      if (Math.max(...roots.map(newestMtime)) >= now - 30 * DAY) continue;
      const record: Manifest = {
        session: { id, title: session.customTitle || session.summary || session.firstPrompt || null,
          createdAt: session.createdAt || session.lastModified, lastActiveAt: session.lastModified },
        files: [],
      };
      const staging = join(archive, `.pending-${id}-${crypto.randomUUID()}`);
      directory(staging);
      try {
        for (const name of names) {
          const bytes = regular(join(live, name), Infinity);
          record.files.push({ path: name, hash: digest(bytes) });
          await atomicAsync(join(staging, `${name}.gz`), Bun.gzipSync(new Uint8Array(bytes)));
        }
        await atomicAsync(join(staging, "manifest.json"), JSON.stringify(record));
        await syncTreeAsync(staging);
        // The copy awaited: commit only if no turn, restore or retirement
        // took the session meanwhile. The staged copy is dropped below.
        if (options.activeSessionIds?.().has(id) || existsSync(join(archive, id)) || retiredOnDisk(archive, id)) continue;
        renameSync(staging, join(archive, id)); await syncDirectoryAsync(archive);
        options.checkpoint?.("archive");
        await reindexAsync(archive, options.log);
        options.checkpoint?.("index");
        if (await removeSource(live, archive, record, options) === false) await setAsideAsync(archive, id, options);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
  } catch (error) {
    try { (options.log ?? ((message, reason) => console.warn(message, reason)))("Claude transcript archival failed", error); }
    catch { /* Logging cannot fail a completed turn either. */ }
  } finally { if (claimed) scanning.delete(claimed); }
}

/**
 * Remove every artifact this backend owns for one retired session (#3229):
 * its live transcript and subordinate tree, its archived, staged and
 * conflict copies and index entry, its display and prompt metadata and its
 * file observations. Synchronous, so no archive step or restore interleaves.
 * Only names derived from the validated session identity are touched; a
 * redirected root or aliased artifact is left alone and reported partial.
 */
export function removeClaudeSession(id: string, options: Pick<ArchiveOptions, "brainPath" | "env">): SessionHistoryRemovalOutcome {
  validateSessionId(id);
  const { live, archive } = transcriptPaths(options.brainPath, options.env);
  const config = dirname(dirname(live));
  const outcomes: SessionHistoryRemovalOutcome[] = [
    removeOwnedArtifact(live, `${id}.jsonl`),
    removeOwnedArtifact(live, id),
    removeOwnedArtifact(archive, id),
    ...ownedNames(archive, name => name.startsWith(`.conflict-${id}-`) || name.startsWith(`.pending-${id}-`))
      .map(name => removeOwnedArtifact(archive, name)),
  ];
  // The index carries titles: drop this entry and keep every other one as it was.
  const indexPath = join(archive, "index.json");
  if (existsSync(indexPath)) {
    const entries = JSON.parse(regular(indexPath, METADATA_BYTES).toString()) as ArchivedSession[];
    if (!Array.isArray(entries)) throw new Error("Invalid transcript archive index");
    if (entries.some(entry => entry?.id === id)) index(archive, entries.filter(entry => entry?.id !== id));
  }
  if (existsSync(options.brainPath)) {
    const brain = realpathSync(options.brainPath);
    outcomes.push(
      removeMetadataFile({ dir: join(archive, "native-observations"), name: `${nativeObservationIdentity(brain, id)}.json` }),
      removeMetadataFile(sessionReplayLocation(config, brain, id)),
      removeMetadataFile(sessionPromptContextLocation(config, brain, id)));
  } else outcomes.push("unknown");
  return combineRemovalOutcomes(outcomes);
}
