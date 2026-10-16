/** Host-owned display metadata. These files are never runtime transcript input. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface TextMapping { digest: string; text: string }
export interface ReplayReceipt { id: string; name: string; input: Record<string, unknown>; output: string; isError: boolean; anchor?: string | null; turnId?: string }
interface Snapshot { texts: Record<string, Record<string, TextMapping>>; receipts: Record<string, ReplayReceipt> }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_BYTES = 64 * 1024 * 1024;
function directory(path: string): void {
  if (existsSync(path)) {
    if (realpathSync(path) !== path) throw new Error("Session replay storage must not contain directory aliases");
    return;
  }
  directory(dirname(path)); mkdirSync(path, { mode: 0o700 });
}
/** Concrete first-party storage, keyed by native session, message and text part. */
export function sessionReplay(root: string, brainPath: string, sessionId: string) {
  const brain = existsSync(brainPath) ? realpathSync(brainPath) : resolve(brainPath), dir = resolve(root, "session-replay", digest(brain));
  let ancestor = dir;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), dir.slice(ancestor.length).replace(/^\//, ""));
  const outside = actual !== brain && !actual.startsWith(brain + "/") && !brain.startsWith(actual + "/");
  const validate = () => {
    if (!outside) throw new Error("Session replay storage must be outside the authoritative brain");
    if (existsSync(dir)) directory(dir);
  };
  const path = join(dir, `${digest(sessionId)}.json`);
  function read(): Snapshot {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { texts: {}, receipts: {} }; throw error; }
    try {
      validate();
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Invalid session replay storage file");
      const bytes = readFileSync(fd);
      if (bytes.length > MAX_BYTES) throw new Error("Session replay storage exceeds its byte bound");
      return JSON.parse(bytes.toString("utf8")) as Snapshot;
    } finally { closeSync(fd); }
  }
  function write(state: Snapshot): void {
    validate();
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Session replay storage exceeds its byte bound");
    directory(dir);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  return {
    /** Retain this message's promoted-link display text without editing the message. */
    retainText(messageId: string, part: number, original: string, text: string): void {
      if (original === text) return;
      const state = read();
      (state.texts[digest(messageId)] ??= {})[part] = { digest: digest(original), text };
      write(state);
    },
    /** A changed/reused native identity never receives another message's mapping. */
    texts() {
      const state = read();
      return (messageId: string, part: number, original: string): string => {
        const mapping = state.texts[digest(messageId)]?.[part];
        return mapping?.digest === digest(original) ? mapping.text : original;
      };
    },
    retainReceipt(receipt: ReplayReceipt): void {
      const state = read(); state.receipts[digest(`${receipt.turnId ?? ""}:${receipt.id}`)] = receipt; write(state);
    },
    receipts(): ReplayReceipt[] { return Object.values(read().receipts); },
  };
}
