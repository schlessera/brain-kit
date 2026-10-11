/** Parent-owned snapshots; the runtime never mounts the host's saved state writable. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const MAX_STATE_BYTES = 128 * 1024 * 1024;
/** Space for CLI state files and growth during the admitted turn. */
export const stateReserveBytes = (transcriptSize: number): number => Math.max(16 * 1024 * 1024, Math.ceil(transcriptSize / 4));

export class SessionTooLargeError extends BackendRequestError {
  readonly errorClass = "session_too_large";
  constructor() {
    super("This conversation exceeds the worker runtime state limit or available tmpfs space. Continue in a new conversation.");
    this.name = "SessionTooLargeError";
  }
}

export const isSessionId = (id: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export function validateSessionId(id: string): void {
  if (!isSessionId(id)) throw new WorkerHostError("invalid resumed session id; expected a UUID");
}

export function regular(path: string, limit = MAX_STATE_BYTES): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new WorkerHostError("runtime state contains an alias, special file or oversized file");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new WorkerHostError("runtime state exceeds its byte bound");
    return bytes;
  } finally { closeSync(fd); }
}
export function directory(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new WorkerHostError("runtime state directory is redirected");
  } else {
    directory(dirname(path)); mkdirSync(path, { mode: 0o700 });
  }
}
export function files(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new WorkerHostError("runtime state directory is redirected");
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name), rel = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(path);
    if (info.isDirectory()) result.push(...files(path, rel));
    else {
      if (!info.isFile() || info.nlink !== 1) throw new WorkerHostError("runtime state contains an alias or special file");
      result.push(rel);
    }
    if (result.length > 10000) throw new WorkerHostError("runtime state exceeds its file bound");
  }
  return result;
}
export function createClaudeWorkerState(brainPath: string, env: Record<string, string | undefined>,
  options: { ephemeral?: boolean; resume?: string; stateRoot?: string; freeBytes?: (path: string) => number } = {}) {
  if (!options.ephemeral && options.resume !== undefined) validateSessionId(options.resume);
  const brain = realpathSync(brainPath);
  const configured = resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
  let ancestor = configured;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), configured.slice(ancestor.length).replace(/^\//, ""));
  if (canonical === brain || canonical.startsWith(`${brain}/`) || brain.startsWith(`${canonical}/`))
    throw new WorkerHostError("Claude config and transcripts must be outside the authoritative brain and its ancestors");
  directory(configured);
  const saved = realpathSync(configured);
  if (saved === brain || saved.startsWith(`${brain}/`) || brain.startsWith(`${saved}/`))
    throw new WorkerHostError("Claude config and transcripts must be outside the authoritative brain and its ancestors");
  // Both fixtures and native CLI use the SDK's project-directory encoding.
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const state = mkdtempSync(join(options.stateRoot ?? "/dev/shm", "brain-claude-state-"));
  // An autonomous turn starts from nothing saved and saves nothing: no stored
  // login, settings, account file or transcript enters or leaves it (#676).
  if (options.ephemeral) return { path: state, persist() {}, cleanup: () => rmSync(state, { recursive: true, force: true }) };
  const initial = new Map<string, string>();
  try {
    const projectRoot = join(saved, project);
    if (existsSync(projectRoot)) directory(projectRoot);
    // Capture membership, not bytes, for other sessions. A worker may create
    // a session but must never export files into an unrelated existing one.
    const existing = new Set(existsSync(projectRoot) ? readdirSync(projectRoot).map(name => name.replace(/\.jsonl$/, "")) : []);
    const settings = ["settings.json", ".credentials.json", ".claude.json"].filter(name => existsSync(join(saved, name)));
    const transcripts: string[] = [];
    if (options.resume) {
      if (existsSync(join(projectRoot, `${options.resume}.jsonl`))) transcripts.push(`${project}/${options.resume}.jsonl`);
      transcripts.push(...files(join(projectRoot, options.resume)).map(name => `${project}/${options.resume}/${name}`));
    }
    const size = (name: string) => {
      const info = lstatSync(join(saved, name));
      if (!info.isFile() || info.nlink !== 1) throw new WorkerHostError("runtime state contains an alias or special file");
      return info.size;
    };
    const capacity = options.freeBytes?.(state) ?? (() => { const fs = statfsSync(state); return fs.bavail * fs.bsize; })();
    const settingsSize = settings.reduce((sum, name) => sum + size(name), 0);
    const limit = Math.min(capacity, MAX_STATE_BYTES);
    if (settingsSize + stateReserveBytes(0) > limit)
      throw new WorkerHostError("Claude settings and credentials do not fit in the runtime-state tmpfs; increase /dev/shm capacity (--shm-size in Docker)");
    const transcriptSize = transcripts.reduce((sum, name) => sum + size(name), 0);
    if (settingsSize + transcriptSize + stateReserveBytes(transcriptSize) > limit) throw new SessionTooLargeError();
    let total = 0, copiedTranscripts = 0;
    for (const name of [...settings, ...transcripts]) {
      const bytes = regular(join(saved, name)); total += bytes.length;
      if (transcripts.includes(name)) copiedTranscripts += bytes.length;
      if (total + stateReserveBytes(copiedTranscripts) > limit) {
        if (transcripts.includes(name)) throw new SessionTooLargeError();
        throw new WorkerHostError("Claude settings changed and no longer fit in runtime state");
      }
      const target = join(state, name); directory(dirname(target)); writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      initial.set(name, hash(bytes));
    }
    return {
      path: state,
      persist() {
        // Only this brain's native transcript files, never worker-supplied
        // commands, settings, destinations or deletion requests. The PID
        // namespace is already gone, so no runtime writer can race this copy.
        let total = 0;
        for (const file of files(join(state, project))) {
          if (!file.endsWith(".jsonl")) continue;
          const id = file.split("/")[0]!.replace(/\.jsonl$/, "");
          if (!isSessionId(id) || (id !== options.resume && existing.has(id))) continue;
          const name = `${project}/${file}`, bytes = regular(join(state, name)); total += bytes.length;
          if (total > MAX_STATE_BYTES) throw new WorkerHostError("runtime transcripts exceed their byte bound");
          if (initial.get(name) === hash(bytes)) continue;
          const target = join(saved, name); directory(dirname(target));
          const present = existsSync(target) ? hash(regular(target)) : undefined;
          if (present !== initial.get(name)) throw new WorkerHostError("saved transcript changed concurrently; refusing overwrite");
          const temp = `${target}.${crypto.randomUUID()}.tmp`;
          try { writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); directory(dirname(target)); renameSync(temp, target); }
          finally { rmSync(temp, { force: true }); }
        }
      },
      cleanup: () => rmSync(state, { recursive: true, force: true }),
    };
  } catch (error) { rmSync(state, { recursive: true, force: true }); if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
    throw new WorkerHostError("runtime-state tmpfs ran out of space during snapshot; increase /dev/shm capacity (--shm-size in Docker)");
  } throw error; }
}
