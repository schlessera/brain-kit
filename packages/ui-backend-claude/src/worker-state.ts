/** Parent-owned snapshots; the runtime never mounts the host's saved state writable. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { pages, stateLedger, tmpfsSpace, type Reservation, type StateLedger, type TmpfsSpace } from "./worker-state-budget.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const MAX_STATE_BYTES = 128 * 1024 * 1024;
/** The runtime's auto-memory folder under the project directory (#1626). */
const MEMORY = "memory";
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
export interface ClaudeWorkerState {
  path: string;
  /** Measures the running turn against its reservation; throws `worker_state_exceeded` (#1625). */
  ensure(): void;
  persist(): void;
  /** Removes the state and releases its reservation, on every exit path. */
  cleanup(): void;
}

export function createClaudeWorkerState(brainPath: string, env: Record<string, string | undefined>,
  options: { ephemeral?: boolean; resume?: string; stateRoot?: string; freeBytes?: (path: string) => number;
    /** The tmpfs's size when `freeBytes` is injected; defaults to the free bytes. */
    totalBytes?: (path: string) => number;
    /** The ledger shared by concurrent turns on this tmpfs (#1625). */
    ledger?: StateLedger; } = {}): ClaudeWorkerState {
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
  const root = options.stateRoot ?? "/dev/shm";
  const state = mkdtempSync(join(root, "brain-claude-state-"));
  const space = (): TmpfsSpace => {
    if (!options.freeBytes) return tmpfsSpace(state);
    const free = options.freeBytes(state);
    return { free, total: options.totalBytes?.(state) ?? free };
  };
  const ledger = options.ledger ?? stateLedger(root, stateReserveBytes(0), MAX_STATE_BYTES);
  let held: Reservation | undefined;
  const cleanup = () => { try { rmSync(state, { recursive: true, force: true }); } finally { held?.release(); } };
  /**
   * Admission (#1621 D5, #1625). What can never fit this tmpfs or the
   * per-turn bound refuses for good; what fits but is held by running turns
   * refuses as `worker_state_busy`. Both happen before any byte is copied.
   */
  const admit = (base: number, transcripts: number): number => {
    const now = space(), limit = Math.min(now.total, MAX_STATE_BYTES);
    if (base + stateReserveBytes(0) > limit)
      throw new WorkerHostError("Claude settings and credentials do not fit in the runtime-state tmpfs with room for a turn to grow; increase /dev/shm capacity (--shm-size in Docker)");
    const needed = base + transcripts + stateReserveBytes(transcripts);
    if (needed > limit) throw new SessionTooLargeError();
    held = ledger.reserve({ path: state, bytes: needed, space });
    return limit;
  };
  // An autonomous turn starts from nothing saved and saves nothing: no stored
  // login, settings, account file or transcript enters or leaves it (#676).
  // It still writes there while it runs, so it reserves room to grow.
  if (options.ephemeral) {
    try { admit(0, 0); } catch (error) { cleanup(); throw error; }
    return { path: state, ensure: () => held?.ensure(), persist() {}, cleanup };
  }
  const initial = new Map<string, string>();
  try {
    const projectRoot = join(saved, project);
    if (existsSync(projectRoot)) directory(projectRoot);
    // Capture membership, not bytes, for other sessions. A worker may create
    // a session but must never export files into an unrelated existing one.
    const existing = new Set(existsSync(projectRoot) ? readdirSync(projectRoot).map(name => name.replace(/\.jsonl$/, "")) : []);
    const settings = ["settings.json", ".credentials.json", ".claude.json"].filter(name => existsSync(join(saved, name)));
    // Every session of the brain reads the project's auto-memory, so every turn copies it (#1626).
    settings.push(...files(join(projectRoot, MEMORY)).map(name => `${project}/${MEMORY}/${name}`));
    const transcripts: string[] = [];
    if (options.resume) {
      if (existsSync(join(projectRoot, `${options.resume}.jsonl`))) transcripts.push(`${project}/${options.resume}.jsonl`);
      transcripts.push(...files(join(projectRoot, options.resume)).map(name => `${project}/${options.resume}/${name}`));
    }
    // Whole tmpfs pages, as the copy will occupy them.
    const size = (name: string) => {
      const info = lstatSync(join(saved, name));
      if (!info.isFile() || info.nlink !== 1) throw new WorkerHostError("runtime state contains an alias or special file");
      return pages(info.size);
    };
    const settingsSize = settings.reduce((sum, name) => sum + size(name), 0);
    const transcriptSize = transcripts.reduce((sum, name) => sum + size(name), 0);
    const limit = admit(settingsSize, transcriptSize);
    let total = 0, copiedTranscripts = 0;
    for (const name of [...settings, ...transcripts]) {
      const bytes = regular(join(saved, name)); total += pages(bytes.length);
      if (transcripts.includes(name)) copiedTranscripts += pages(bytes.length);
      if (total + stateReserveBytes(copiedTranscripts) > limit) {
        if (transcripts.includes(name)) throw new SessionTooLargeError();
        throw new WorkerHostError("Claude settings or memory changed and no longer fit in runtime state");
      }
      const target = join(state, name); directory(dirname(target)); writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      initial.set(name, hash(bytes));
    }
    /** Write one changed file back, refusing to overwrite a saved file that changed meanwhile. */
    const write = (name: string, bytes: Buffer, what: "transcript" | "memory"): void => {
      const target = join(saved, name); directory(dirname(target));
      const present = existsSync(target) ? hash(regular(target)) : undefined;
      if (present !== initial.get(name)) throw new WorkerHostError(`saved ${what} changed concurrently; refusing overwrite`);
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      try { writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); directory(dirname(target)); renameSync(temp, target); }
      finally { rmSync(temp, { force: true }); }
    };
    return {
      path: state,
      ensure: () => held?.ensure(),
      persist() {
        // Only this brain's native transcript files and its memory notes, never
        // worker-supplied commands, settings, destinations or deletion
        // requests. The PID namespace is already gone, so no runtime writer can
        // race this copy.
        let total = 0;
        const notes: [string, Buffer][] = [];
        for (const file of files(join(state, project))) {
          if (file.startsWith(`${MEMORY}/`)) {
            // Agent memory (#1626): only a `.md` note directly in the folder.
            const note = file.slice(MEMORY.length + 1);
            if (note.includes("/") || !note.endsWith(".md")) continue;
            const name = `${project}/${file}`, bytes = regular(join(state, name)); total += bytes.length;
            if (total > MAX_STATE_BYTES) throw new WorkerHostError("runtime transcripts and memory exceed their byte bound");
            if (initial.get(name) !== hash(bytes)) notes.push([name, bytes]);
            continue;
          }
          if (!file.endsWith(".jsonl")) continue;
          const id = file.split("/")[0]!.replace(/\.jsonl$/, "");
          if (!isSessionId(id) || (id !== options.resume && existing.has(id))) continue;
          const name = `${project}/${file}`, bytes = regular(join(state, name)); total += bytes.length;
          if (total > MAX_STATE_BYTES) throw new WorkerHostError("runtime transcripts and memory exceed their byte bound");
          if (initial.get(name) === hash(bytes)) continue;
          write(name, bytes, "transcript");
        }
        // Every session of the brain shares its memory. A note another turn
        // changed meanwhile is refused alone and named; the other notes still
        // persist, and nothing is ever deleted.
        const refused: string[] = [];
        for (const [name, bytes] of notes) {
          try { write(name, bytes, "memory"); } catch (error) {
            if (!(error instanceof WorkerHostError && error.message.includes("changed concurrently"))) throw error;
            refused.push(name.slice(project.length + 1));
          }
        }
        if (refused.length) throw new WorkerHostError(`saved memory changed concurrently; refusing overwrite of ${refused.join(", ")}`);
      },
      cleanup,
    };
  } catch (error) { cleanup(); if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
    throw new WorkerHostError("runtime-state tmpfs ran out of space during snapshot; increase /dev/shm capacity (--shm-size in Docker)");
  } throw error; }
}
