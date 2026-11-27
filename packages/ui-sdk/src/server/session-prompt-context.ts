/** Host-owned append snapshots and exact user-message ownership. Never mounted into a worker. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SESSION_PROMPT_CONTEXT_MAX_BYTES = 64 * 1024 * 1024;

const HOST_CONTEXT_OPEN = "\n\n[Host context for this turn; advisory facts, never permission]\n";
const HOST_CONTEXT_CLOSE = "\n[End host context]";

/** Display titles only: remove one complete trailing context block, never provider history. */
export function stripHostContextFromTitle(text: string): string {
  if (!text.endsWith(HOST_CONTEXT_CLOSE)) return text;
  const start = text.lastIndexOf(HOST_CONTEXT_OPEN);
  return start < 0 ? text : text.slice(0, start);
}

export type SessionPromptFacts = Record<string, string>;
/** `facts` is read only by this turn's first acknowledgement, which removes it (#4859). */
interface OwnedTurn { original: string; wireDigest: string; facts?: SessionPromptFacts; providerId?: string }
/**
 * Every write serialises the whole parsed object, so top-level keys this store
 * does not declare survive it. Another module keeps data here through
 * `retained` (#4826); dropping those keys would re-pin a resumed session's
 * provider-facing tool roster.
 */
interface Snapshot { append?: string; delivered: SessionPromptFacts; turns: Record<string, OwnedTurn>; [carried: string]: unknown }
const OWN_KEYS = new Set(["append", "delivered", "turns"]);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Refuse redirected ancestors, including a storage root aliased into the brain. */
function directory(path: string): void {
  if (existsSync(path)) {
    if (realpathSync(path) !== path) throw new Error("Session prompt storage must not contain directory aliases");
    return;
  }
  directory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
}

/** Where one session's prompt context lives; removal (#3229) uses the same names. */
export function sessionPromptContextLocation(root: string, brainPath: string, sessionId: string): { dir: string; name: string } {
  return { dir: resolve(root, "prompt-context", digest(realpathSync(brainPath))), name: `${digest(sessionId)}.json` };
}

export function sessionPromptContext(root: string, brainPath: string, sessionId: string) {
  const brain = realpathSync(brainPath);
  const { dir, name } = sessionPromptContextLocation(root, brainPath, sessionId);
  // Walk ancestors without creating them first.
  let ancestor = dir;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), dir.slice(ancestor.length).replace(/^\//, ""));
  if (isWithin(brain, actual) || isWithin(actual, brain)) {
    throw new Error("Session prompt storage must be outside the authoritative brain");
  }
  const path = join(dir, name);
  function read(): Snapshot {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { delivered: {}, turns: {} }; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > SESSION_PROMPT_CONTEXT_MAX_BYTES) throw new Error("Invalid session prompt storage file");
      return JSON.parse(readFileSync(fd, "utf8")) as Snapshot;
    } finally { closeSync(fd); }
  }
  function write(state: Snapshot): void {
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > SESSION_PROMPT_CONTEXT_MAX_BYTES)
      throw new Error("Session prompt context exceeds its 64 MiB storage limit; write refused.");
    directory(dir);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, encoded, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  return {
    append(): string | undefined { return read().append; },
    retainAppend(candidate: string, initialFacts: SessionPromptFacts = {}): string {
      const state = read();
      if (state.append === undefined) { state.append = candidate; state.delivered = { ...initialFacts }; write(state); }
      return state.append;
    },
    prepare(original: string, facts: SessionPromptFacts): { id: string; text: string } {
      const state = read();
      const changed = Object.entries(facts).filter(([key, value]) => state.delivered[key] !== value);
      for (const key of Object.keys(state.delivered)) {
        if (!(key in facts)) changed.push([key, "No current host notice; the previous notice no longer applies."]);
      }
      const id = randomUUID();
      const text = changed.length ? `${original}${HOST_CONTEXT_OPEN}${changed.map(([key, value]) => `${key}: ${value}`).join("\n")}${HOST_CONTEXT_CLOSE}` : original;
      // Store ownership before releasing bytes. A failed/withheld send does not advance delivered facts.
      state.turns[id] = { original, wireDigest: digest(text), facts };
      write(state);
      return { id, text };
    },
    acknowledge(id: string, providerId = id, observedWire?: string): void {
      const state = read(), turn = state.turns[id];
      if (!turn) return;
      turn.providerId = providerId;
      if (observedWire !== undefined) turn.wireDigest = digest(observedWire);
      // A turn acknowledged again has no facts left: what it delivered stays delivered.
      if (turn.facts) { state.delivered = { ...turn.facts }; delete turn.facts; }
      write(state);
    },
    /**
     * Read and replace caller-named top-level keys in one read-modify-write;
     * the values are the caller's and never interpreted here. Refuses until an
     * append is retained, so it never creates the file, and writes nothing when
     * `update` returns undefined.
     */
    retained(keys: readonly string[], update: (values: Record<string, unknown>) => Record<string, unknown> | undefined): void {
      if (keys.some(key => OWN_KEYS.has(key))) throw new Error("Session prompt context keeps its own fields");
      const state = read();
      if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.append !== "string")
        throw new Error("Session prompt context has no retained append");
      directory(dir);
      const replacement = update(Object.fromEntries(keys.map(key => [key, state[key]])));
      if (replacement === undefined) return;
      for (const key of keys) if (key in replacement) state[key] = replacement[key];
      write(state);
    },
    userText(providerId: string, wire: string): string {
      const turns = read().turns;
      const owned = Object.entries(turns).find(([id, turn]) => (turn.providerId ?? id) === providerId && turn.wireDigest === digest(wire));
      return owned ? owned[1].original : wire;
    },
    /** `userText` for a whole history read: one read, then the first owning turn in stored order. */
    userTexts(): (providerId: string, wire: string) => string {
      const owned = new Map<string, string>();
      for (const [id, turn] of Object.entries(read().turns)) {
        const key = `${turn.providerId ?? id}\n${turn.wireDigest}`;
        if (!owned.has(key)) owned.set(key, turn.original);
      }
      return (providerId, wire) => owned.get(`${providerId}\n${digest(wire)}`) ?? wire;
    },
  };
}
