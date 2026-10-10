import { constants, closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";

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
