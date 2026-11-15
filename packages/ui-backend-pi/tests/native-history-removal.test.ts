/**
 * Explicit removal of a retired chat's native Pi history (#3229), through the
 * installed SessionManager's own listing and reading against isolated
 * synthetic Odysseus files. No live store, provider or network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { BackendRequestError, type AgentBackend, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { nativeObservationIdentity, sessionPromptContextLocation, sessionReplayLocation } from "@schlessera/brain-ui-sdk/internal";
import { createPiBackend, type PiSessionLike } from "../src/backend.js";
import { savePiSession } from "../src/session-storage.js";

const MARKER = "Odysseus hid the oar under the olive root";
const BRANCH = "Odysseus first tried the cave of the winds";
const CONTROL = "Penelope kept the loom unfinished";
let root: string, brain: string, sessionDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-pi-removal-")));
  brain = join(root, "ithaca"); sessionDir = join(root, "pi-sessions"); mkdirSync(brain); mkdirSync(sessionDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages",
  provider: "anthropic", model: "m", usage, stopReason: "stop", timestamp }) as never;
/** A SessionManager tree under the SDK's own file name, with an inactive branch. */
function tree(text: string, inactive?: string): string {
  const manager = SessionManager.create(brain, sessionDir);
  const user = manager.appendMessage({ role: "user", content: `Where is the oar? ${text}`, timestamp: 1 } as never);
  if (inactive) { manager.appendMessage(answer(inactive, 2)); manager.branch(user); }
  manager.appendMessage(answer(text, 3));
  return manager.getSessionId();
}
function metadata(id: string, text: string) {
  const replay = sessionReplayLocation(sessionDir, brain, id), prompt = sessionPromptContextLocation(sessionDir, brain, id);
  mkdirSync(replay.dir, { recursive: true }); mkdirSync(prompt.dir, { recursive: true });
  writeFileSync(join(replay.dir, replay.name), JSON.stringify({ texts: {}, receipts: { r: { id: "r", name: "brain_add", input: { text }, output: text, isError: false } } }));
  writeFileSync(join(prompt.dir, `${prompt.name}`), JSON.stringify({ append: text, delivered: {}, turns: {} }));
  writeFileSync(join(prompt.dir, `${prompt.name}.crashed.tmp`), text);
  const observations = join(sessionDir, "native-observations"); mkdirSync(observations, { recursive: true });
  writeFileSync(join(observations, `${nativeObservationIdentity(brain, id)}.json`), JSON.stringify({ schema: 1, identity: text, incomplete: false, observed: [] }));
}
function seed() {
  const target = tree(MARKER, BRANCH), control = tree(CONTROL);
  // The canonical server-owned copy of the same tree, as a later turn writes it.
  const legacy = readdirSync(sessionDir).find(name => name.endsWith(`_${target}.jsonl`))!;
  savePiSession(sessionDir, target, readFileSync(join(sessionDir, legacy), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  metadata(target, MARKER); metadata(control, CONTROL);
  return { target, control };
}
function stored(path = sessionDir): string {
  if (!existsSync(path)) return "";
  const info = lstatSync(path);
  if (info.isDirectory()) return readdirSync(path).map(name => stored(join(path, name))).join("\n");
  return info.isFile() ? readFileSync(path, "utf8") : "";
}
const text = (history: Awaited<ReturnType<AgentBackend["getHistory"]>>) => JSON.stringify(history);
const bridge = { emit: () => {}, requestPermission: async () => ({ behavior: "deny" as const, message: "no" }) };
function resume(backend: AgentBackend, sessionId: string): Promise<void> {
  return backend.startTurn({ prompt: "Continue the voyage", sessionId, signal: new AbortController().signal, bridge } as unknown as StartTurnRequest);
}

test("removes the whole session tree and its metadata through the installed SessionManager", async () => {
  const { target, control } = seed();
  const backend = createPiBackend({ brainPath: brain, sessionDir });
  expect(backend.capabilities.historyRemoval).toBe(true);
  // Both the SDK-named and the canonical copy of the target are listed.
  expect([...new Set((await backend.listSessions()).map(session => session.id))].sort()).toEqual([target, control].sort());
  expect(text(await backend.getHistory(target))).toContain(MARKER);
  // The inactive branch is not rendered, but it is stored.
  expect(text(await backend.getHistory(target))).not.toContain(BRANCH);
  expect(stored()).toContain(BRANCH);

  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: target })).toEqual({ outcome: "removed" });

  const after = stored();
  expect(after, "NO_OWNED_MARKER_REMAINS").not.toContain(MARKER);
  expect(after, "NO_INACTIVE_BRANCH_REMAINS").not.toContain(BRANCH);
  expect((await SessionManager.list(brain, sessionDir)).map(info => info.id)).toEqual([control]);
  expect((await backend.listSessions()).map(session => session.id)).toEqual([control]);
  expect(await backend.getHistory(target)).toEqual([]);
  await expect(resume(backend, target)).rejects.toBeInstanceOf(BackendRequestError);
  expect(readFileSync(join(sessionDir, "retired", target), "utf8")).toBe("retire-voyage");
  expect(text(await backend.getHistory(control))).toContain(CONTROL);
  expect(after).toContain(CONTROL);

  // A restarted backend keeps the fence, even against a transcript an old backup brings back.
  const restarted = createPiBackend({ brainPath: brain, sessionDir });
  savePiSession(sessionDir, target, [{ type: "session", version: 3, id: target, timestamp: "2026-07-12T10:00:00.000Z", cwd: brain },
    { type: "message", id: "a1b2c3d4", parentId: null, timestamp: "2026-07-12T10:00:01.000Z", message: { role: "user", content: MARKER, timestamp: 1 } }]);
  expect((await restarted.listSessions()).map(session => session.id)).toEqual([control]);
  expect(await restarted.getHistory(target)).toEqual([]);
  await expect(restarted.removeSessionHistory!({ operationId: "replacement", sessionId: target })).rejects.toBeInstanceOf(BackendRequestError);
  expect(await restarted.removeSessionHistory!({ operationId: "retire-voyage", sessionId: target })).toEqual({ outcome: "removed" });
  expect(stored()).not.toContain(MARKER);
});

test("a transcript is attributed by its header, and links stay untouched", async () => {
  const { target, control } = seed();
  // The canonical name now holds another chat's tree: replaced, not owned.
  const controlFile = readdirSync(sessionDir).find(name => name.endsWith(`_${control}.jsonl`))!;
  rmSync(join(sessionDir, `${target}.jsonl`));
  writeFileSync(join(sessionDir, `${target}.jsonl`), readFileSync(join(sessionDir, controlFile)));
  // And the display file has a second name elsewhere.
  const penelope = join(root, "penelope-letters"); mkdirSync(penelope);
  const replay = sessionReplayLocation(sessionDir, brain, target);
  linkSync(join(replay.dir, replay.name), join(penelope, "copy.json"));
  const backend = createPiBackend({ brainPath: brain, sessionDir });

  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: target })).toEqual({ outcome: "partial" });
  expect(existsSync(join(sessionDir, `${target}.jsonl`)), "REPLACED_FILE_NOT_DELETED").toBe(true);
  expect(readFileSync(join(sessionDir, `${target}.jsonl`), "utf8")).toContain(CONTROL);
  expect(existsSync(join(replay.dir, replay.name)), "HARD_LINK_NOT_UNLINKED").toBe(true);
  expect(lstatSync(join(replay.dir, replay.name)).nlink).toBe(2);
  // The tree its header attributes to the target is gone; the control chat is intact.
  expect(readdirSync(sessionDir).filter(name => name.endsWith(`_${target}.jsonl`))).toEqual([]);
  expect(readFileSync(join(sessionDir, controlFile), "utf8")).toContain(CONTROL);
  expect(text(await backend.getHistory(control))).toContain(CONTROL);
  await expect(backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: "../penelope-letters" })).rejects.toBeInstanceOf(BackendRequestError);
  expect(existsSync(penelope)).toBe(true);
});

test("a running turn drains before removal and its resident session is disposed", async () => {
  const { target } = seed();
  let finish!: () => void, disposed = false;
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: PiSessionLike = {
    sessionId: target,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    prompt: () => new Promise<void>(resolve => { finish = resolve; }),
    async abort() { finish?.(); },
    getSessionStats: () => ({ cost: 0 }),
    dispose() { disposed = true; },
  };
  const backend = createPiBackend({ brainPath: brain, sessionDir, sessionFactory: {
    newSession: async () => session, openSession: async () => session } });
  const turn = resume(backend, target);
  while (!finish) await Bun.sleep(1);
  const removal = backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: target });
  const deadline = new AbortController(); deadline.abort();
  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: target, signal: deadline.signal })).toEqual({ outcome: "partial" });
  await expect(backend.removeSessionHistory!({ operationId: "replacement", sessionId: target })).rejects.toBeInstanceOf(BackendRequestError);
  // Fenced at once: follow-up and resume refuse while the turn still holds the session.
  await expect(backend.followUp!({ sessionId: target, prompt: "And the bow?" })).rejects.toBeInstanceOf(BackendRequestError);
  expect(stored(), "REMOVAL_WAITS_FOR_THE_TURN").toContain(MARKER);
  finish(); await turn;
  expect(await removal).toEqual({ outcome: "removed" });
  expect(disposed, "RESIDENT_SESSION_DISPOSED").toBe(true);
  expect(stored()).not.toContain(MARKER);
  await expect(resume(backend, target)).rejects.toBeInstanceOf(BackendRequestError);
});
