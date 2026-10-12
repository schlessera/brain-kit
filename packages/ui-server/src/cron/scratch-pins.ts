import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SHOW_BLOCK_TOOL_NAME, visibleToolName } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendRegistry } from "../agent/backend.js";

const BLOCK_NAMES = new Set([visibleToolName(SHOW_BLOCK_TOOL_NAME, "pi"), visibleToolName(SHOW_BLOCK_TOOL_NAME, "claude"),
  visibleToolName(SHOW_BLOCK_TOOL_NAME, "claude").replace("mcp__brain-ui__", "mcp__brain_ui__")]);
const PIN_FILE = ".brain/scratch-pins/pins.json";
type Snapshot = { version: 1; ready: boolean; sessions: Record<string, string[]> };

/** Conservative: extra pins cost space; a missed link costs retained content. */
export function scratchLinks(messages: SessionHistoryMessage[]): string[] {
  const paths = new Set<string>();
  const add = (raw: string) => {
    const interpretations = [raw];
    try { interpretations.push(decodeURIComponent(raw)); } catch { /* Literal percent in a filename. */ }
    for (const target of interpretations) {
      const normalized = target.replace(/^\.\//, "").replace(/^\/+/, "");
      // Keep encoded filename punctuation and URL fragment interpretations.
      for (let path of [normalized, normalized.split(/[?#]/)[0]!]) {
        if (!path.startsWith(".brain/scratch/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) ||
            path.split("/").some(part => !part || part === "." || part === "..")) continue;
        paths.add(path);
        while (/[),.;!\]]$/.test(path)) { path = path.slice(0, -1); if (path !== ".brain/scratch/") paths.add(path); }
      }
    }
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    // Structured inline blocks can also expose artifact links in the answer.
    const surfaces = [message.content, JSON.stringify(message.blocks ?? []),
      ...message.toolCalls.filter(call => BLOCK_NAMES.has(call.name)).map(call => JSON.stringify(call.input))];
    const source = surfaces.join("\n");
    let text: string;
    try { text = decodeURIComponent(source); } catch { text = source; }
    for (const match of text.matchAll(/(?:\.brain(?:\/|%2f)scratch(?:\/|%2f)|%2ebrain%2fscratch%2f)[^\s<>"`'|]+/gi)) add(match[0]);
    for (const match of text.matchAll(/"((?:\.\/)?\.brain\/scratch\/[^"\n]+)"/g)) add(match[1]!);
    for (const match of text.matchAll(/<((?:\.\/|\/)?\.brain\/scratch\/[^>\n]+)>|\[\[((?:\.\/)?\.brain\/scratch\/[^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)) add(match[1] ?? match[2]!);
    for (const match of message.content.matchAll(/\/api\/files\/content\?([^\s<>"')]+)/g)) {
      const path = new URLSearchParams(match[1]).get("path"); if (path) add(path);
    }
  }
  return [...paths].sort();
}

/** Concrete server-to-CLI data bridge, not a dependency on core or its index. */
export function createScratchPins(root: string, registry: BackendRegistry) {
  let store: ReturnType<typeof openScratchPins> | undefined;
  let closed = false;
  // Pin storage is maintenance, not a startup prerequisite. Preserve the
  // server's existing ability to start with an unavailable brain; pruning
  // stays suspended and its ordinary warning records the failed setup.
  try { store = openScratchPins(root, registry); } catch { /* Retried by refresh/record. */ }
  const get = () => {
    if (closed) throw new Error("Scratch pin store is closed");
    return store ??= openScratchPins(root, registry);
  };
  return {
    get file(): string { return store?.file ?? resolve(root, PIN_FILE); },
    close(): void { closed = true; store?.close(); },
    record(sessionId: string, backendId: string, messages: SessionHistoryMessage[]): void {
      get().record(sessionId, backendId, messages);
    },
    async refresh(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted(); await get().refresh(signal);
    },
  };
}

function openScratchPins(root: string, registry: BackendRegistry) {
  const canonical = realpathSync(root);
  const file = join(canonical, PIN_FILE);
  // Same anchored directory technique as the application route: a renamed
  // parent cannot redirect this host-side writer outside the brain.
  const descriptors: number[] = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const openDirectory = (path: string): number => {
    const fd = openSync(path, flags); descriptors.push(fd); return fd;
  };
  const child = (parent: number, name: string): number => {
    const path = `/proc/self/fd/${parent}/${name}`;
    try { mkdirSync(path, { mode: 0o750 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return openDirectory(path);
  };
  let closed = false;
  const close = () => { closed = true; for (const fd of descriptors.splice(0).reverse()) closeSync(fd); };
  let dir: string;
  try {
    const rootFd = openDirectory(canonical), brainFd = child(rootFd, ".brain");
    const pinFd = child(brainFd, "scratch-pins"), markerFd = child(brainFd, "scratch-pins-required");
    dir = `/proc/self/fd/${pinFd}`;
    // The independent marker survives losing the entire snapshot directory.
    // Both directories are operational state, never brain content.
    for (const fd of [pinFd, markerFd]) {
      try { writeFileSync(`/proc/self/fd/${fd}/.gitignore`, "*\n", { flag: "wx", mode: 0o640 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  } catch (error) { close(); throw error; }
  let state: Snapshot = { version: 1, ready: false, sessions: {} };
  try {
    const fd = openSync(`${dir}/pins.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("scratch pins are not a regular file");
      const previous = JSON.parse(readFileSync(fd, "utf8")) as Snapshot;
      if (previous.version === 1 && previous.sessions && typeof previous.sessions === "object" && !Array.isArray(previous.sessions) &&
          Object.values(previous.sessions).every(paths => Array.isArray(paths) && paths.every(path => typeof path === "string"))) state.sessions = previous.sessions;
    } finally { closeSync(fd); }
  } catch { /* Backfill is mandatory before any deletion, including on restart. */ }
  const publish = () => {
    if (closed) throw new Error("Scratch pin store is closed");
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(state), { flag: "wx", mode: 0o640 });
    try { renameSync(tmp, `${dir}/pins.json`); }
    finally { try { unlinkSync(tmp); } catch { /* published or already gone */ } }
  };
  try { publish(); } catch (error) { close(); throw error; } // Crash or failed backfill leaves pruning suspended for every caller.
  let recordedDuringScan: Record<string, string[]> | null = null;
  // Backends cannot cancel reads. Coalesce a hung read across timer attempts.
  const reads = new Map<string, Promise<unknown>>();
  async function read<T>(key: string, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let pendingRead = reads.get(key);
    if (!pendingRead) {
      pendingRead = Promise.resolve().then(work); reads.set(key, pendingRead);
      const clear = () => { if (reads.get(key) === pendingRead) reads.delete(key); };
      void pendingRead.then(clear, clear);
    }
    let abort!: () => void;
    try {
      return await Promise.race([pendingRead as Promise<T>, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("Scratch pin scan aborted"));
        signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  }
  let pending: Promise<void> = Promise.resolve();
  const serialize = (work: () => Promise<void>): Promise<void> => {
    const next = pending.then(work); pending = next.catch(() => {}); return next;
  };
  return {
    file, close,
    record(sessionId: string, backendId: string, messages: SessionHistoryMessage[]): void {
      const key = JSON.stringify([backendId, sessionId]);
      const paths = [...new Set([...(state.sessions[key] ?? []), ...scratchLinks(messages)])].sort();
      state.sessions[key] = paths;
      if (recordedDuringScan) recordedDuringScan[key] = paths;
      publish();
    },
    refresh(signal: AbortSignal): Promise<void> {
      return serialize(async () => {
        // Do not trust a stale ready snapshot if enumeration or any read fails.
        state.ready = false; publish();
        const previous = { ...state.sessions };
        // A disabled/unavailable backend is not evidence of session deletion.
        const next: Record<string, string[]> = { ...previous };
        recordedDuringScan = Object.create(null);
        try {
          for (const backend of await read("backends", () => registry.getBackends(), signal)) {
            signal.throwIfAborted();
            const listed = await read(JSON.stringify([backend.id, "list"]), () => backend.listSessions(), signal);
            const ids = new Set(listed.map(session => session.id));
            for (const session of listed) {
              signal.throwIfAborted();
              const messages = await read(JSON.stringify([backend.id, "history", session.id]), () => backend.getHistory(session.id), signal);
              signal.throwIfAborted();
              const key = JSON.stringify([backend.id, session.id]);
              next[key] = [...new Set([...(previous[key] ?? []), ...scratchLinks(messages)])].sort();
            }
            // First-party listings can degrade to a partial or empty array.
            // Confirm missing sessions through history before releasing pins;
            // an unreadable archive fails the whole scan safely.
            for (const [key, paths] of Object.entries(previous)) {
              let identity: unknown;
              try { identity = JSON.parse(key); } catch { continue; }
              if (!Array.isArray(identity) || identity.length !== 2 || identity[0] !== backend.id || typeof identity[1] !== "string" || ids.has(identity[1])) continue;
              const sessionId = identity[1];
              if (paths.length === 0) { delete next[key]; continue; }
              const messages = await read(JSON.stringify([backend.id, "history", sessionId]), () => backend.getHistory(sessionId), signal);
              signal.throwIfAborted();
              if (messages.length === 0) delete next[key];
              else next[key] = [...new Set([...paths, ...scratchLinks(messages)])].sort();
            }
          }
          signal.throwIfAborted();
          // Only complete enumeration releases deleted/out-of-retention sessions.
          state = { version: 1, ready: true, sessions: { ...next, ...recordedDuringScan } }; publish();
        } catch (error) { state.ready = false; publish(); throw error; }
        finally { recordedDuringScan = null; }
      });
    },
  };
}
