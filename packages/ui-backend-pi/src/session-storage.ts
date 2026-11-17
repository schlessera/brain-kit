import { constants, closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { SessionHistoryRemovalOutcome } from "@schlessera/brain-ui-sdk/server";
import { combineRemovalOutcomes, nativeObservationIdentity, ownedNames, removeMetadataFile, removeOwnedArtifact, sessionPromptContextLocation, sessionReplayLocation } from "@schlessera/brain-ui-sdk/internal";

/** Server-owned state is never mounted writable into a worker. */
export function piSessionDirectory(brainPath: string, configured?: string): string {
  const root = realpathSync(brainPath);
  const key = createHash("sha256").update(root).digest("hex");
  const dir = resolve(configured ?? join(homedir(), ".local/state/brain-kit/pi", key, "sessions"));
  // Check existing ancestors BEFORE mkdir, including a symlink into the brain.
  let ancestor = dir;
  while (true) {
    try { realpathSync(ancestor); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) throw e;
      ancestor = parent;
    }
  }
  const actual = resolve(realpathSync(ancestor), relative(ancestor, dir));
  if (inside(root, actual) || inside(actual, root)) {
    throw new BackendRequestError("Pi sessionDir must be outside the brain and its ancestors, without aliases into it.");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}
function inside(root: string, path: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }

/** Fixed server-minted UUID paths, O_NOFOLLOW, and no shared-inode writes. */
export function savePiSession(dir: string, sessionId: string, entries: unknown[]): void {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error("Invalid server session identity");
  const path = join(dir, `${sessionId}.jsonl`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Pi transcript must be an unaliased regular file");
    // Never truncate before inode validation.
    const bytes = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
    ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
  } finally { closeSync(fd); }
}

export function readPiSession(path: string): import("@earendil-works/pi-coding-agent").FileEntry[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new BackendRequestError("Pi transcript must be an unaliased regular file");
    return readFileSync(fd, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  } finally { closeSync(fd); }
}

/** Only the server-selected native credential file; never a worker path. */
export function syncPiAuth(dir: string, original: string | undefined, content: string): void {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid pi credential state");
  const fd = openSync(join(dir, "auth.json"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Pi credential state must be an unaliased regular file");
    const current = readFileSync(fd, "utf8");
    if (current !== (original ?? "")) throw new Error("Pi credential state changed concurrently; no worker state was applied");
    // readFileSync advanced the descriptor; positional write keeps the exact
    // proposed bytes, then trims any old suffix after validation.
    writeSync(fd, content, 0, "utf8");
    ftruncateSync(fd, Buffer.byteLength(content));
  } finally { closeSync(fd); }
}

/** Server-minted Pi session identities, the only ones a removal or tombstone names. */
export const isPiSessionId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
/** Content-free tombstones of explicitly retired sessions (#3229); permanent. */
export const piRetiredDirectory = (sessionDir: string) => join(sessionDir, "retired");

const HEADER_BYTES = 64 * 1024;
/** The session header of one plain, single-name transcript file, or undefined. */
function header(path: string): { type?: unknown; id?: unknown; cwd?: unknown } | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return undefined;
    const buffer = Buffer.alloc(HEADER_BYTES), count = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const line = buffer.subarray(0, count).toString("utf8").split("\n")[0];
    try { return JSON.parse(line!); } catch { return undefined; }
  } finally { closeSync(fd); }
}

/**
 * Remove every artifact this backend owns for one retired session (#3229):
 * the whole SessionManager tree (every branch, under its canonical name and
 * any older SDK-managed name whose header names it in this brain), display
 * and prompt metadata and file observations. A transcript is attributed by
 * its own header, never by a matching name alone: a canonical name whose
 * header is missing or names another session is left in place, partial.
 */
export function removePiSession(sessionDir: string, brainPath: string, id: string): SessionHistoryRemovalOutcome {
  if (!isPiSessionId(id)) throw new BackendRequestError("Invalid server session identity");
  const outcomes: SessionHistoryRemovalOutcome[] = [];
  for (const name of ownedNames(sessionDir, name => name.endsWith(".jsonl"))) {
    const canonical = name === `${id}.jsonl`, found = header(join(sessionDir, name));
    const ours = found?.type === "session" && found.id === id;
    if (ours && found.cwd === brainPath) outcomes.push(removeOwnedArtifact(sessionDir, name));
    else if (canonical) outcomes.push("partial");
  }
  if (!existsSync(brainPath)) return combineRemovalOutcomes([...outcomes, "unknown"]);
  const brain = realpathSync(brainPath);
  outcomes.push(
    removeMetadataFile({ dir: join(sessionDir, "native-observations"), name: `${nativeObservationIdentity(brain, id)}.json` }),
    removeMetadataFile(sessionReplayLocation(sessionDir, brainPath, id)),
    removeMetadataFile(sessionPromptContextLocation(sessionDir, brainPath, id)));
  return combineRemovalOutcomes(outcomes);
}
