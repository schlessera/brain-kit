/**
 * Explicit removal of a retired chat's native Claude history (#3229), through
 * the installed Agent SDK's own listing and reading against isolated synthetic
 * Odysseus files. No live store, provider or network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { BackendRequestError, type AgentBackend, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { nativeObservationIdentity, sessionPromptContextLocation, sessionReplayLocation } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
import { restoreArchivedSession, transcriptPaths } from "../src/transcript-archive.js";

const MARKER = "Odysseus hid the oar under the olive root";
const CONTROL = "Penelope kept the loom unfinished";
const TARGET = "0d755e05-1111-4111-8111-111111111111";
const OTHER = "9e7e10e0-2222-4222-8222-222222222222";
const ARCHIVED = "4c1e0a11-3333-4333-8333-333333333333";
let root: string, brain: string, config: string, live: string, archive: string, previous: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-native-removal-")));
  brain = join(root, "ithaca"); config = join(root, "claude-config"); mkdirSync(brain); mkdirSync(config);
  previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = config;
  ({ live, archive } = transcriptPaths(brain, { CLAUDE_CONFIG_DIR: config }));
  mkdirSync(live, { recursive: true }); mkdirSync(archive, { recursive: true });
});
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function transcript(id: string, text: string): string {
  const base = { sessionId: id, cwd: brain, version: "2.1.0", userType: "external", isSidechain: false, gitBranch: "" };
  const user = crypto.randomUUID(), answer = crypto.randomUUID();
  return [
    { ...base, type: "user", uuid: user, parentUuid: null, timestamp: "2026-07-12T10:00:00.000Z", message: { role: "user", content: `Where is the oar? ${text}` } },
    { ...base, type: "assistant", uuid: answer, parentUuid: user, timestamp: "2026-07-12T10:00:01.000Z",
      message: { id: `msg_${answer}`, type: "message", role: "assistant", model: "claude", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
}
function metadata(id: string, text: string) {
  const replay = sessionReplayLocation(config, brain, id), prompt = sessionPromptContextLocation(config, brain, id);
  mkdirSync(replay.dir, { recursive: true }); mkdirSync(prompt.dir, { recursive: true });
  writeFileSync(join(replay.dir, replay.name), JSON.stringify({ texts: {}, receipts: { r: { id: "r", name: "brain_add", input: { text }, output: text, isError: false } } }));
  writeFileSync(join(prompt.dir, prompt.name), JSON.stringify({ append: text, delivered: {}, turns: { t: { original: text, wireDigest: "0", facts: {} } } }));
  const observations = join(archive, "native-observations"); mkdirSync(observations, { recursive: true });
  writeFileSync(join(observations, `${nativeObservationIdentity(brain, id)}.json`), JSON.stringify({ schema: 1, identity: text, incomplete: false, observed: [] }));
}
/** The target in every owned shape: live, subordinate, archived, staged, conflict, index, display, prompt, observations. */
function archived(id: string, text: string) {
  mkdirSync(join(archive, id)); writeFileSync(join(archive, id, `${id}.jsonl.gz`), Bun.gzipSync(new TextEncoder().encode(text)));
  writeFileSync(join(archive, id, "manifest.json"), JSON.stringify({ session: { id, title: text, createdAt: 1, lastActiveAt: 1 }, files: [] }));
}
function seed() {
  writeFileSync(join(live, `${TARGET}.jsonl`), transcript(TARGET, MARKER));
  mkdirSync(join(live, TARGET, "subagents"), { recursive: true });
  writeFileSync(join(live, TARGET, "subagents", "agent-telemachus.jsonl"), MARKER);
  archived(TARGET, MARKER);
  mkdirSync(join(archive, `.pending-${TARGET}-stage`)); writeFileSync(join(archive, `.pending-${TARGET}-stage`, "a.gz"), Bun.gzipSync(new TextEncoder().encode(MARKER)));
  mkdirSync(join(archive, `.conflict-${TARGET}-1783850400000`)); writeFileSync(join(archive, `.conflict-${TARGET}-1783850400000`, "manifest.json"), MARKER);
  // An unrelated archived chat shares the index.
  archived(ARCHIVED, CONTROL);
  writeFileSync(join(archive, "index.json"), JSON.stringify([{ id: TARGET, title: MARKER, createdAt: 1, lastActiveAt: 1 }, { id: ARCHIVED, title: CONTROL, createdAt: 1, lastActiveAt: 1 }]));
  metadata(TARGET, MARKER);
  const replay = sessionReplayLocation(config, brain, TARGET);
  writeFileSync(join(replay.dir, `${replay.name}.crashed.tmp`), MARKER);
  // The unrelated control chat, including a conflict copy whose name only resembles the target's.
  writeFileSync(join(live, `${OTHER}.jsonl`), transcript(OTHER, CONTROL));
  mkdirSync(join(archive, `.conflict-${OTHER}-1`)); writeFileSync(join(archive, `.conflict-${OTHER}-1`, "manifest.json"), CONTROL);
  metadata(OTHER, CONTROL);
}
/** Every byte under the config tree, gzip copies included. */
function stored(path = config): string {
  if (!existsSync(path)) return "";
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return "";
  if (info.isDirectory()) return readdirSync(path).map(name => stored(join(path, name))).join("\n");
  const bytes = readFileSync(path);
  return path.endsWith(".gz") ? new TextDecoder().decode(Bun.gunzipSync(bytes)) : bytes.toString("utf8");
}
const text = (history: Awaited<ReturnType<AgentBackend["getHistory"]>>) => JSON.stringify(history);
function resume(backend: AgentBackend, sessionId: string): Promise<void> {
  return backend.startTurn({ prompt: "Continue the voyage", sessionId, signal: new AbortController().signal,
    bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "no" }) } } as unknown as StartTurnRequest);
}
function gate() {
  let open!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { open = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  return { open, entered, released, reached };
}

test("removes every owned artifact through the installed SDK and keeps the unrelated chat", async () => {
  seed();
  const backend = createClaudeBackend({ brainPath: brain });
  expect(backend.capabilities.historyRemoval).toBe(true);
  expect((await backend.listSessions()).map(session => session.id).sort()).toEqual([TARGET, OTHER, ARCHIVED].sort());
  expect(text(await backend.getHistory(TARGET))).toContain(MARKER);
  expect(stored()).toContain(MARKER);

  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET })).toEqual({ outcome: "removed" });

  expect(stored(), "NO_OWNED_MARKER_REMAINS").not.toContain(MARKER);
  expect((await listSessions({ dir: brain })).map(session => session.sessionId)).toEqual([OTHER]);
  expect(await getSessionMessages(TARGET, { dir: brain })).toEqual([]);
  expect((await backend.listSessions()).map(session => session.id).sort()).toEqual([OTHER, ARCHIVED].sort());
  expect(await backend.getHistory(TARGET)).toEqual([]);
  expect(resume(backend, TARGET)).rejects.toBeInstanceOf(BackendRequestError);
  // The tombstone is content-free: only the operation identity.
  expect(readFileSync(join(archive, "retired", TARGET), "utf8")).toBe("retire-voyage");
  // The control chat is untouched and readable.
  expect(text(await backend.getHistory(OTHER))).toContain(CONTROL);
  expect(JSON.parse(readFileSync(join(archive, "index.json"), "utf8"))).toEqual([{ id: ARCHIVED, title: CONTROL, createdAt: 1, lastActiveAt: 1 }]);
  expect(readFileSync(join(archive, `.conflict-${OTHER}-1`, "manifest.json"), "utf8")).toBe(CONTROL);
  expect(stored()).toContain(CONTROL);
  // Repeating the same operation is idempotent; another operation never re-owns the session.
  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET })).toEqual({ outcome: "removed" });
  expect(backend.removeSessionHistory!({ operationId: "retire-again", sessionId: TARGET })).rejects.toBeInstanceOf(BackendRequestError);
});

test("a reader started before retirement drains first and publishes nothing after it", async () => {
  seed();
  const reading = gate();
  const backend = createClaudeBackend({ brainPath: brain, getSessionMessagesFn: (async (...args: Parameters<typeof getSessionMessages>) => {
    const messages = await getSessionMessages(...args);
    reading.entered(); await reading.released;
    return messages;
  }) as typeof getSessionMessages });
  const read = backend.getHistory(TARGET);
  await reading.reached;
  const removal = backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET });
  // Fenced at once: a new reader, lister and resume see an unknown chat while removal waits.
  expect(await backend.getHistory(TARGET)).toEqual([]);
  expect((await backend.listSessions()).map(session => session.id).sort()).toEqual([OTHER, ARCHIVED].sort());
  expect(resume(backend, TARGET)).rejects.toBeInstanceOf(BackendRequestError);
  // A bounded caller wait is partial, and the removal keeps its single owner.
  const deadline = new AbortController(); deadline.abort();
  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET, signal: deadline.signal })).toEqual({ outcome: "partial" });
  expect(backend.removeSessionHistory!({ operationId: "replacement", sessionId: TARGET })).rejects.toBeInstanceOf(BackendRequestError);
  expect(stored(), "REMOVAL_WAITS_FOR_THE_READER").toContain(MARKER);
  reading.open();
  expect(text(await read), "RETIRED_READ_PUBLISHES_NOTHING").not.toContain(MARKER);
  expect(await removal).toEqual({ outcome: "removed" });
  expect(stored()).not.toContain(MARKER);
});

test("a restarted backend keeps the fence, refuses restored archives and finishes the same operation", async () => {
  seed();
  const reading = gate();
  const first = createClaudeBackend({ brainPath: brain, getSessionMessagesFn: (async (...args: Parameters<typeof getSessionMessages>) => {
    reading.entered(); await reading.released; return getSessionMessages(...args);
  }) as typeof getSessionMessages });
  const firstRead = first.getHistory(TARGET);
  await reading.reached;
  const deadline = new AbortController(); deadline.abort();
  // The process stops while the reader holds the chat: only the tombstone is durable.
  expect(await first.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET, signal: deadline.signal })).toEqual({ outcome: "partial" });
  // And a crash had already taken part of the content.
  rmSync(join(live, TARGET), { recursive: true });

  const restarted = createClaudeBackend({ brainPath: brain });
  expect((await restarted.listSessions()).map(session => session.id).sort()).toEqual([OTHER, ARCHIVED].sort());
  expect(await restarted.getHistory(TARGET)).toEqual([]);
  // An old backup brings an archived copy back after retirement.
  if (!existsSync(join(archive, TARGET))) archived(TARGET, MARKER);
  restoreArchivedSession(TARGET, { brainPath: brain });
  expect(readFileSync(join(live, `${TARGET}.jsonl`), "utf8")).toContain(MARKER);
  expect(existsSync(join(archive, TARGET)), "RETIRED_ARCHIVE_NOT_RESTORED").toBe(true);
  expect(restarted.removeSessionHistory!({ operationId: "replacement", sessionId: TARGET })).rejects.toBeInstanceOf(BackendRequestError);
  expect(await restarted.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET })).toEqual({ outcome: "removed" });
  expect(stored()).not.toContain(MARKER);
  // The stopped process's reader, if it ever resumed, still publishes nothing.
  reading.open();
  expect(text(await firstRead)).not.toContain(MARKER);
});

test("links, hard links and redirected roots stay untouched and keep the removal partial", async () => {
  seed();
  const penelope = join(root, "penelope-letters"); mkdirSync(penelope);
  writeFileSync(join(penelope, "letter.txt"), CONTROL);
  // A live transcript replaced by a link, a subordinate link and a hard-linked display file.
  rmSync(join(live, `${TARGET}.jsonl`)); symlinkSync(join(penelope, "letter.txt"), join(live, `${TARGET}.jsonl`));
  symlinkSync(penelope, join(live, TARGET, "letters"));
  const replay = sessionReplayLocation(config, brain, TARGET);
  linkSync(join(replay.dir, replay.name), join(penelope, "copy.json"));
  const backend = createClaudeBackend({ brainPath: brain });

  expect(await backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET })).toEqual({ outcome: "partial" });
  expect(readFileSync(join(penelope, "letter.txt"), "utf8")).toBe(CONTROL);
  expect(lstatSync(join(live, `${TARGET}.jsonl`)).isSymbolicLink()).toBe(true);
  expect(existsSync(join(live, TARGET, "letters"))).toBe(true);
  expect(lstatSync(join(replay.dir, replay.name)).nlink, "HARD_LINK_NOT_UNLINKED").toBe(2);
  expect(readFileSync(join(penelope, "copy.json"), "utf8")).toContain(MARKER);
  // Everything the chat solely owns was still removed, and it stays fenced.
  expect(existsSync(join(archive, TARGET))).toBe(false);
  expect((await backend.listSessions()).map(session => session.id).sort()).toEqual([OTHER, ARCHIVED].sort());
  // A client path is never a session identity.
  expect(backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: "../penelope-letters" })).rejects.toBeInstanceOf(BackendRequestError);
  expect(existsSync(penelope)).toBe(true);
});

test("a redirected archive root refuses before any removal", async () => {
  seed();
  const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere); writeFileSync(join(elsewhere, "kept.txt"), CONTROL);
  rmSync(archive, { recursive: true }); symlinkSync(elsewhere, archive);
  const backend = createClaudeBackend({ brainPath: brain });
  expect(backend.removeSessionHistory!({ operationId: "retire-voyage", sessionId: TARGET })).rejects.toBeInstanceOf(BackendRequestError);
  expect(readdirSync(elsewhere)).toEqual(["kept.txt"]);
  expect(readFileSync(join(live, `${TARGET}.jsonl`), "utf8")).toContain(MARKER);
});
