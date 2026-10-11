/** Native Claude transcripts remain authoritative; this is their cold storage. */
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { envSnapshot } from "./config/env.js";
import { directory, files, isSessionId, regular, validateSessionId } from "./worker-state.js";

const DAY = 24 * 60 * 60 * 1000;
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

function syncTree(path: string) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) syncTree(child);
  }
  syncDirectory(path);
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
function manifest(root: string, id: string): Manifest {
  directory(join(root, id));
  const value = JSON.parse(regular(join(root, id, "manifest.json")).toString()) as Manifest;
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
function index(root: string, entries: ArchivedSession[]) {
  atomic(join(root, "index.json"), JSON.stringify(entries));
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
  renameSync(join(archive, id), join(archive, `.conflict-${id}-${options.now?.() ?? Date.now()}`)); syncDirectory(archive);
  index(archive, manifests(archive, options.log).map(m => m.session));
  (options.log ?? ((message, reason) => console.warn(message, reason)))(
    `Transcript ${id} changed after it was archived; kept the live copy and set the archived one aside`, undefined);
}

/** Include committed manifests if a crash preceded the atomic index update. */
export function listArchivedSessions(options: ArchiveOptions): ArchivedSession[] {
  const { archive } = transcriptPaths(options.brainPath, options.env);
  const committed = manifests(archive, options.log).map(m => m.session);
  const indexPath = join(archive, "index.json");
  const entries: ArchivedSession[] = existsSync(indexPath) ? JSON.parse(regular(indexPath).toString()) : [];
  if (!Array.isArray(entries) || !entries.every(s => typeof s.id === "string" && isSessionId(s.id)))
    throw new Error("Invalid transcript archive index");
  return [...new Map([...entries, ...committed].map(s => [s.id, s])).values()];
}

/** Restore before history reads or worker snapshots. Synchronous: no turn can
 * start or archive between validation and publication in this backend process. */
export function restoreArchivedSession(id: string, options: ArchiveOptions): void {
  validateSessionId(id);
  const { live, archive } = transcriptPaths(options.brainPath, options.env);
  const source = join(archive, id);
  if (!existsSync(source)) return;
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
/** False, deleting nothing, when the live source changed after the archive copy was taken. */
function removeSource(live: string, archive: string, record: Manifest): boolean {
  // Validate the entire remaining source before deleting anything. A crash
  // during deletion leaves a subset, which the same check accepts on restart.
  const known = new Map(record.files.map(f => [f.path, f.hash]));
  const remaining = sessionFiles(live, record.session.id);
  for (const file of remaining) {
    if (digest(regular(join(live, file), Infinity)) !== known.get(file)) return false;
  }
  // Verify the durable copy even on recovery, before removing live bytes.
  for (const file of record.files) archivedBytes(archive, record.session.id, file);
  for (const file of remaining) {
    rmSync(join(live, file)); syncDirectory(dirname(join(live, file)));
  }
  pruneEmpty(join(live, record.session.id));
  if (existsSync(live)) syncDirectory(live);
  return true;
}

/** Best effort, at most daily, and always outside the autonomous envelope. */
export async function archiveIdleSessions(options: ArchiveOptions): Promise<void> {
  try {
    const { live, archive } = transcriptPaths(options.brainPath, options.env);
    if (!existsSync(live) && !existsSync(archive)) return;
    const now = options.now?.() ?? Date.now();
    const marker = join(archive, "last-scan");
    if (existsSync(marker) && now - Number(regular(marker).toString()) < DAY) return;
    atomic(marker, String(now));
    const sessions = await (options.listSessionsFn ?? sdkListSessions)({ dir: options.brainPath });
    const active = options.activeSessionIds?.() ?? new Set<string>();
    // Recovery precedes fresh moves. Committed manifests are immutable, so a
    // lost index write or partially removed source is safe to retry.
    for (const record of manifests(archive, options.log)) {
      if (active.has(record.session.id)) continue;
      if (existsSync(join(archive, record.session.id, "restoring"))) {
        restoreArchivedSession(record.session.id, options);
      } else {
        index(archive, manifests(archive, options.log).map(m => m.session));
        if (!removeSource(live, archive, record)) setAside(archive, record.session.id, options);
      }
    }
    for (const session of sessions) {
      const id = session.sessionId;
      if (!isSessionId(id) || active.has(id) || existsSync(join(archive, id))) continue;
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
          atomic(join(staging, `${name}.gz`), Bun.gzipSync(new Uint8Array(bytes)));
        }
        atomic(join(staging, "manifest.json"), JSON.stringify(record));
        syncTree(staging);
        renameSync(staging, join(archive, id)); syncDirectory(archive);
        options.checkpoint?.("archive");
        index(archive, manifests(archive, options.log).map(m => m.session));
        options.checkpoint?.("index");
        if (!removeSource(live, archive, record)) setAside(archive, id, options);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
  } catch (error) {
    try { (options.log ?? ((message, reason) => console.warn(message, reason)))("Claude transcript archival failed", error); }
    catch { /* Logging cannot fail a completed turn either. */ }
  }
}
