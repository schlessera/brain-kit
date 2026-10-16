/**
 * Parent-owned snapshots; the runtime never mounts the host's saved state
 * writable. Each worker's runtime state is a private tmpfs of a fixed
 * allowance (#1625): the server copies the snapshot in before the worker's
 * command starts and copies validated results out after its namespace is gone.
 */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BackendRequestError, type TurnFailure } from "@schlessera/brain-ui-sdk/server";
import { FIRST_PARTY_FAILURE_CLASSES, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import { recoveredWorkerFile, recoveredWorkerFiles, sessionReplay, mib, resolveWorkerStateLimits, WORKER_STATE_BYTES_ENV, WorkerHostError, type WorkerNoteLimit, type WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";
import { processStateLedger, type Reservation, type StateLedger } from "./worker-state-budget.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** tmpfs allocates whole pages, so every byte count is rounded up to one. */
const PAGE = 4096;
export const pages = (bytes: number): number => Math.ceil(bytes / PAGE) * PAGE;
/** The runtime's auto-memory folder under the project directory (#1626). */
const MEMORY = "memory";

export class SessionTooLargeError extends BackendRequestError {
  readonly errorClass = FIRST_PARTY_FAILURE_CLASSES.session_too_large;
  constructor(needed: number, allowance: number) {
    super(`This conversation's saved runtime state (${mib(needed)}) does not fit the worker's ${mib(allowance)} `
      + "runtime-state allowance. Continue in a new conversation.");
    this.name = "SessionTooLargeError";
  }
}

/** Safe copy-out disclosure: filesystem exceptions may contain private paths or content. */
export function workerStateSaveReason(error: unknown): string {
  const reason = error instanceof WorkerHostError ? error.requirement : "";
  if (reason.startsWith("saved transcript changed concurrently")) return "The saved transcript changed concurrently and was not overwritten.";
  if (reason.startsWith("saved memory changed concurrently")) return "Saved agent memory changed concurrently and was not overwritten.";
  if (/alias|special file|redirected/.test(reason)) return "Runtime state contained a link, alias or special file, so its copy-out was refused.";
  if (/byte bound|oversized file|file bound/.test(reason)) return "Runtime state exceeded a copy-out bound, so its copy-out was refused.";
  return "The server could not copy the worker's runtime state back to saved storage.";
}

export function workerStateSaveFailure(error: unknown): TurnFailure {
  return { errorClass: FIRST_PARTY_FAILURE_CLASSES.worker_state_save_refused,
    message: "This turn's transcript or agent memory was not saved in full. " + workerStateSaveReason(error)
      + " Some files may already have been saved. Retry the request if needed; retrying does not recover the unsaved state." };
}

export const isSessionId = (id: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export function validateSessionId(id: string): void {
  if (!isSessionId(id)) throw new WorkerHostError("invalid resumed session id; expected a UUID");
}

/** Reads one regular, unaliased file of at most `limit` bytes, never following a link. */
export function regular(path: string, limit: number): Buffer {
  const recovered = recoveredWorkerFile(path, limit);
  if (recovered !== undefined) return recovered;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      const recovered = recoveredWorkerFile(path, limit);
      if (recovered !== undefined) return recovered;
    }
    throw error;
  }
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
/**
 * Every file below `root`, refusing links, aliases and special files.
 * `resolved: false` walks a worker's private tmpfs through the server's held
 * descriptor (`/proc/self/fd/N/...`), whose real path is not its name. Its
 * worker is gone by then, so nothing can swap an entry between checks.
 */
export function files(root: string, prefix = "", options: { resolved?: boolean } = {}): string[] {
  if (options.resolved === false) {
    const recovered = recoveredWorkerFiles(root);
    if (recovered !== undefined) return recovered.map(name => prefix ? `${prefix}/${name}` : name);
  }
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory() || (options.resolved !== false && realpathSync(root) !== root)) {
    throw new WorkerHostError("runtime state directory is redirected");
  }
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name), rel = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(path);
    if (info.isDirectory()) result.push(...files(path, rel, options));
    else {
      if (!info.isFile() || info.nlink !== 1) throw new WorkerHostError("runtime state contains an alias or special file");
      result.push(rel);
    }
    if (result.length > 10000) throw new WorkerHostError("runtime state exceeds its file bound");
  }
  return result;
}

export interface ClaudeWorkerState {
  /** Available only after the actual bounded copy, for a resumed interactive session. */
  readonly observation?: StateRoomObservation;
  /** The allowance this worker was admitted with: its tmpfs size, fixed for its lifetime. */
  readonly bytes: number;
  /** The turn-temp allowance admitted with it (#1703): its `/tmp` size, fixed for its lifetime; 0 without one. */
  readonly turnTempBytes: number;
  /** Copies the snapshot into the worker's empty private tmpfs, before its command starts. */
  populate(root: string): void;
  /**
   * Copies validated results out of the private tmpfs, after the worker's
   * namespace is gone; `rewrite` promotes newly appended answer links for display.
   */
  persist(root: string, rewrite?: (text: string) => string): void;
  /** Prepare only newly appended answer links before synchronous publication. */
  prepareCopyOut?(root: string, prepare: (text: string) => Promise<void>, signal?: AbortSignal): Promise<void>;
  /** Releases the admission reservation; idempotent, called on every exit path. */
  release(): void;
}

/**
 * Admits a worker's runtime state, then plans it. A budget held by running
 * workers refuses first, as `worker_state_busy`; a conversation that can never
 * fit the allowance refuses for good as `session_too_large` and releases its
 * reservation. Both happen before any worker exists or any byte is copied.
 */
export function createClaudeWorkerState(brainPath: string, env: Record<string, string | undefined>,
  options: { ephemeral?: boolean; resume?: string;
    /** The resolved allowance and budget; defaults to 64 MiB and three workers. */
    limits?: WorkerStateLimits;
    /** Defaults to the server process's one ledger. */
    ledger?: StateLedger;
    /** The resolved turn-temp allowance and budget (#1703), admitted together with runtime state. */
    turnTempLimits?: WorkerStateLimits;
    /** A reservation the caller already holds for this worker; ownership passes here. */
    reservation?: Reservation; } = {}): ClaudeWorkerState {
  const limits = options.limits ?? resolveWorkerStateLimits({});
  // Admission first: a busy budget refuses before anything is read.
  const held = options.reservation ?? (options.ledger ?? processStateLedger()).reserve(limits, options.turnTempLimits);
  try { return plan(brainPath, env, options, limits, held); }
  catch (error) { held.release(); throw error; }
}

function plan(brainPath: string, env: Record<string, string | undefined>,
  options: { ephemeral?: boolean; resume?: string }, limits: WorkerStateLimits, held: Reservation): ClaudeWorkerState {
  if (!options.ephemeral && options.resume !== undefined) validateSessionId(options.resume);
  const allowance = held.bytes;
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
  // An autonomous turn starts from nothing saved and saves nothing: no stored
  // login, settings, account file or transcript enters or leaves it (#676).
  // It still writes there while it runs, so it reserves its allowance too.
  if (options.ephemeral) return { bytes: held.bytes, turnTempBytes: held.turnTempBytes, populate() {}, persist() {}, release: () => held.release() };
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
  const settingsTooLarge = () => new WorkerHostError(`Claude settings, credentials and agent memory do not fit the worker's `
    + `${mib(allowance)} runtime-state allowance; raise ${WORKER_STATE_BYTES_ENV}`);
  if (settingsSize > allowance) throw settingsTooLarge();
  const transcriptSize = transcripts.reduce((sum, name) => sum + size(name), 0);
  if (settingsSize + transcriptSize > allowance) throw new SessionTooLargeError(settingsSize + transcriptSize, allowance);
  const initial = new Map<string, string>(), initialLength = new Map<string, number>();
  /** Write one changed file back, refusing to overwrite a saved file that changed meanwhile. */
  const write = (name: string, bytes: Buffer, what: "transcript" | "memory"): void => {
    const target = join(saved, name); directory(dirname(target));
    const present = existsSync(target) ? hash(regular(target, allowance)) : undefined;
    if (present !== initial.get(name)) throw new WorkerHostError(`saved ${what} changed concurrently; refusing overwrite`);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); directory(dirname(target)); renameSync(temp, target); }
    finally { rmSync(temp, { force: true }); }
  };
  let observation: StateRoomObservation | undefined;
  return {
    get observation() { return observation; },
    bytes: held.bytes,
    turnTempBytes: held.turnTempBytes,
    release: () => held.release(),
    populate(root) {
      // The files are read again here, each bounded and refusing links; one
      // that grew since admission refuses as it would have then.
      let total = 0;
      try {
        for (const name of [...settings, ...transcripts]) {
          const tooLarge = () => transcripts.includes(name) ? new SessionTooLargeError(total, allowance) : settingsTooLarge();
          // Sized before it is read, so a file that grew refuses by name; the
          // read itself stays bounded.
          if (total + size(name) > allowance) { total += size(name); throw tooLarge(); }
          const bytes = regular(join(saved, name), allowance); total += pages(bytes.length);
          if (total > allowance) throw tooLarge();
          const target = join(root, name);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
          initial.set(name, hash(bytes)); initialLength.set(name, bytes.length);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new SessionTooLargeError(total, allowance);
        throw error;
      }
      if (options.resume && transcripts.length > 0) observation = { usedBytes: total, allowanceBytes: allowance, observedAt: Date.now() };
    },
    /**
     * `rewrite` observes this turn’s answer links for promotion. All transcript
     * bytes stay exactly as the runtime wrote them (#2049).
     */
    async prepareCopyOut(root, prepare, signal) {
      for (const file of files(join(root, project), "", { resolved: false })) {
        signal?.throwIfAborted();
        if (file.includes("/") || !file.endsWith(".jsonl")) continue;
        const id = file.replace(/\.jsonl$/, "");
        if (!isSessionId(id) || (id !== options.resume && existing.has(id))) continue;
        const name = `${project}/${file}`, bytes = regular(join(root, name), allowance);
        const prefix = initial.has(name) ? { length: initialLength.get(name)!, hash: initial.get(name)! } : undefined;
        const texts: string[] = [];
        rewriteAppendedAnswers(bytes, prefix, text => { texts.push(text); return text; });
        for (const text of texts) { signal?.throwIfAborted(); await prepare(text); }
      }
    },
    persist(root, rewrite) {
      // Only this brain's native transcript files and its memory notes, never
      // worker-supplied commands, settings, destinations or deletion requests.
      // The worker's PID namespace is already gone, so no runtime writer can
      // race this copy.
      let total = 0;
      const notes: [string, Buffer][] = [];
      for (const file of files(join(root, project), "", { resolved: false })) {
        if (file.startsWith(`${MEMORY}/`)) {
          // Agent memory (#1626): only a `.md` note directly in the folder.
          const note = file.slice(MEMORY.length + 1);
          if (note.includes("/") || !note.endsWith(".md")) continue;
          const name = `${project}/${file}`, bytes = regular(join(root, name), allowance); total += bytes.length;
          if (total > allowance) throw new WorkerHostError("runtime transcripts and memory exceed their byte bound");
          if (initial.get(name) !== hash(bytes)) notes.push([name, bytes]);
          continue;
        }
        if (!file.endsWith(".jsonl")) continue;
        const id = file.split("/")[0]!.replace(/\.jsonl$/, "");
        if (!isSessionId(id) || (id !== options.resume && existing.has(id))) continue;
        const name = `${project}/${file}`, read = regular(join(root, name), allowance); total += read.length;
        if (total > allowance) throw new WorkerHostError("runtime transcripts and memory exceed their byte bound");
        const prefix = initial.has(name) ? { length: initialLength.get(name)!, hash: initial.get(name)! } : undefined;
        // Only a session's own transcript holds the answer; subagent files stay as written.
        // Promotion observes only newly appended answer parts. Its display output
        // belongs to host metadata; copy out the exact runtime bytes.
        if (rewrite && !file.includes("/")) {
          const display = sessionReplay(saved, brain, id);
          rewriteAppendedAnswers(read, prefix, (text, messageId, part) => {
            const next = rewrite(text);
            if (messageId !== undefined) display.retainText(messageId, part!, text, next);
            return text;
          });
        }
        const bytes = read;
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
  };
}

/**
 * The runtime-state line of the agent's note, rendered from the resolved
 * allowance through the sandbox note's limits seam (#1625, #1654).
 */
export function workerStateLimit(limits: WorkerStateLimits): WorkerNoteLimit {
  return { name: "Runtime state", value: mib(limits.allowanceBytes),
    onHit: "`$CLAUDE_CONFIG_DIR` holds this conversation's transcript, settings and auto-memory on a private tmpfs of that size. "
      + "It is not for files you make. When it is full, writes to it fail and the turn ends as `worker_state_exceeded`." };
}

/**
 * The transcript with the answer text of the lines appended after `prefix`
 * passed through `rewrite` (#1655). A transcript whose saved prefix changed is
 * returned as it is: nothing but this run's own lines may be rewritten.
 */
export function rewriteAppendedAnswers(bytes: Buffer, prefix: { length: number; hash: string } | undefined,
  rewrite: (text: string, messageId?: string, part?: number) => string): Buffer {
  const start = prefix?.length ?? 0;
  if (prefix && (bytes.length < start || hash(bytes.subarray(0, start)) !== prefix.hash)) return bytes;
  let changed = false;
  const lines = bytes.subarray(start).toString("utf8").split("\n").map(line => {
    if (!line.includes("\"assistant\"")) return line;
    let record: { type?: unknown; uuid?: string; message?: { content?: unknown } };
    try { record = JSON.parse(line); } catch { return line; }
    if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return line;
    let touched = false;
    for (const [index, part] of (record.message.content as Array<{ type?: unknown; text?: unknown }>).entries()) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const next = rewrite(part.text, record.uuid, index);
      if (next !== part.text) { part.text = next; touched = true; }
    }
    if (!touched) return line;
    changed = true;
    return JSON.stringify(record);
  });
  return changed ? Buffer.concat([bytes.subarray(0, start), Buffer.from(lines.join("\n"))]) : bytes;
}
