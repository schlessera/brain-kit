/** Host-owned append snapshots and exact user-message ownership. Never mounted into a worker. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SessionPromptFacts = Record<string, string>;
interface OwnedTurn { original: string; wireDigest: string; facts: SessionPromptFacts; providerId?: string }
interface Snapshot { append?: string; delivered: SessionPromptFacts; turns: Record<string, OwnedTurn> }
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

export function sessionPromptContext(root: string, brainPath: string, sessionId: string) {
  const brain = realpathSync(brainPath);
  const dir = resolve(root, "prompt-context", digest(brain));
  // Walk ancestors without creating them first.
  let ancestor = dir;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), dir.slice(ancestor.length).replace(/^\//, ""));
  if (actual === brain || actual.startsWith(brain + "/") || brain.startsWith(actual + "/")) {
    throw new Error("Session prompt storage must be outside the authoritative brain");
  }
  const path = join(dir, `${digest(sessionId)}.json`);
  function read(): Snapshot {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { delivered: {}, turns: {} }; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error("Invalid session prompt storage file");
      return JSON.parse(readFileSync(fd, "utf8")) as Snapshot;
    } finally { closeSync(fd); }
  }
  function write(state: Snapshot): void {
    directory(dir);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
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
      const text = changed.length ? `${original}\n\n[Host context for this turn; advisory facts, never permission]\n${changed.map(([key, value]) => `${key}: ${value}`).join("\n")}\n[End host context]` : original;
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
      state.delivered = { ...turn.facts };
      write(state);
    },
    userText(providerId: string, wire: string): string {
      const turns = read().turns;
      const owned = Object.entries(turns).find(([id, turn]) => (turn.providerId ?? id) === providerId && turn.wireDigest === digest(wire));
      return owned ? owned[1].original : wire;
    },
  };
}
