/**
 * Transcript frames (#4856): the worker sends its transcript whole once and
 * then only what it appended, and the host keeps the session file byte for
 * byte what a whole rewrite of the worker's list would write.
 */
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import * as sdkInternal from "@schlessera/brain-ui-sdk/internal";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { LaunchedWorker, NativeFileVersions } from "@schlessera/brain-ui-sdk/internal";

import { readPiSession } from "../src/session-storage";
import { createTurnContext } from "../src/turn-context";
import { PI_PIPE_MAX_BYTES, SessionTooLargeError, sendPipe, snapshotFrameBytes } from "../src/worker-protocol";
import { readPiWorkerProtocol, type PiWorkerTurnState } from "../src/worker-reader";
import { createPiWorkerReceipts, type PiWorkerReceipts } from "../src/worker-receipts";

const SESSION = "11111111-1111-4111-8111-111111111111";
type Entry = Record<string, any>;
type Frame = { type: string; base?: number; entries?: Entry[]; event?: Entry };
let root: string, brain: string, sessionDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-transcript-frames-"));
  brain = join(root, "brain"); sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const serialized = (entries: readonly unknown[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
const transcriptFrames = (frames: Frame[]) => frames.filter(frame => frame.type === "snapshot" || frame.type === "transcript_append");
/** The list a receiver holds after each transcript frame. */
function lists(frames: Frame[]): Entry[][] {
  let held: Entry[] = [];
  return transcriptFrames(frames).map(frame => {
    held = frame.type === "snapshot" ? [...frame.entries!] : [...held, ...frame.entries!];
    return held;
  });
}

/** Runs the real worker entry over a scripted session runtime; returns its frames, raw lines and final list. */
async function runWorker(mode: string, init: Record<string, unknown> = {}) {
  const scratch = mkdtempSync(join(root, "worker-"));
  const messages = [
    { type: "init", backend: { brainPath: brain }, env: { caps: {} }, sessionId: SESSION, resume: false, agentFiles: {}, ...init },
    { type: "prompt", text: "Sail home to Ithaca" },
  ];
  const input = join(scratch, "stdin"), output = join(scratch, "stdout"), diagnostic = join(scratch, "stderr");
  writeFileSync(input, messages.map(m => JSON.stringify(m)).join("\n") + "\n");
  const fds = [openSync(input, "r"), openSync(output, "w"), openSync(diagnostic, "w")];
  let code: number;
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker-transcript-probe.ts"), scratch, mode],
      { stdin: fds[0], stdout: fds[1], stderr: fds[2] });
    code = await child.exited;
  } finally { fds.forEach(fd => closeSync(fd)); }
  expect(readFileSync(diagnostic, "utf8")).toBe("");
  expect(code).toBe(0);
  const lines = readFileSync(output, "utf8").trim().split("\n");
  const final = existsSync(join(scratch, "final.json")) ? JSON.parse(readFileSync(join(scratch, "final.json"), "utf8")) as Entry[] : undefined;
  return { lines, frames: lines.map(line => JSON.parse(line)) as Frame[], final };
}

function fakeChild() {
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  const child = { stdout, stderr, stdin, exited: new Promise<number>(() => {}), kill: () => {}, released: async () => {},
    limitReport: () => ({ hits: [], fatal: false }) } as unknown as LaunchedWorker;
  return { child, stdout };
}

/**
 * Feeds frames to the real host reader and receipts; records the session file after every save.
 * With `listener`, the turn's events reach the reader too, and the listener sees each one.
 */
async function readOnHost(frames: Frame[], receipts: PiWorkerReceipts, resumedIds: Set<unknown> = new Set(), listener?: (event: Entry) => void) {
  const { child, stdout } = fakeChild();
  const state: PiWorkerTurnState = { active: true, initialized: true, ended: false, error: undefined, cost: 0,
    thinkingLevel: undefined, levels: [], model: undefined, ownedPrompt: undefined };
  const path = join(sessionDir, `${SESSION}.jsonl`), files: (string | undefined)[] = [];
  const persist = receipts.persist;
  receipts.persist = (recover?: boolean) => { persist(recover); files.push(existsSync(path) ? readFileSync(path, "utf8") : undefined); };
  const reading = readPiWorkerProtocol({ child, state, ready: Promise.withResolvers<void>(), done: Promise.withResolvers<void>(), sessionId: SESSION,
    backend: { brainPath: brain }, startupStarted: 0, promptContext: undefined, sessionBudgetLimits: undefined, autonomous: false, resumed: false,
    turnContext: createTurnContext(), nativeVersions: { cancelPending() {} } as unknown as NativeFileVersions, receipts, resumedIds,
    listeners: new Set(listener ? [listener as never] : []),
    proof: { loaded: () => {}, started: () => {}, ended: () => undefined }, toolExecution: undefined, dispatch: async () => undefined, send: () => {},
    fail: () => {}, reportLimitHits: () => {}, limitEnded: async () => undefined, diagnostic: () => "" });
  for (const frame of listener ? frames.filter(frame => frame.type === "event" || transcriptFrames([frame]).length) : transcriptFrames(frames)) sendPipe(stdout, frame);
  sendPipe(stdout, { type: "done", cost: 0 });
  stdout.end();
  await reading;
  receipts.persist = persist;
  return files;
}

const receiptsFor = (entries?: Entry[]) => createPiWorkerReceipts({ sessionDir, brainPath: brain, sessionId: SESSION, autonomous: false,
  entries: entries as never, resumedIds: new Set(entries?.map(entry => entry.id)), turn: createTurnContext(), backend: {} });

test("after its first transcript frame the worker sends only the entries it appended", async () => {
  const { frames, lines, final } = await runWorker("turn");
  const sent = transcriptFrames(frames), sizes = lines.filter((_, i) => frames[i]!.type === "snapshot" || frames[i]!.type === "transcript_append")
    .map(line => Buffer.byteLength(line) + 1);
  expect(sent[0]!.type).toBe("snapshot");
  expect(lists(frames).at(-1)).toEqual(final!);
  const seen = new Set<unknown>();
  for (const [index, frame] of sent.entries()) {
    const ids = frame.entries!.map(entry => entry.id);
    expect(ids.filter(id => seen.has(id)), `PI_TRANSCRIPT_FRAME_${index}_RESENDS_NO_ENTRY`).toEqual([]);
    ids.forEach(id => seen.add(id));
  }
  // Each frame's envelope is its type, its base and its brackets: well under 64 bytes.
  const total = sizes.reduce((sum, size) => sum + size, 0);
  expect(total, "PI_TRANSCRIPT_BYTES_ARE_LINEAR").toBeLessThanOrEqual(snapshotFrameBytes(final!) + 64 * sent.length);
});

test("a list rebuilt from the same entries in another order is sent whole", async () => {
  const { frames, final } = await runWorker("branch");
  const sent = transcriptFrames(frames);
  expect(sent.map(frame => frame.type).lastIndexOf("snapshot"), "PI_REORDERED_LIST_SENDS_A_WHOLE_SNAPSHOT").toBeGreaterThan(0);
  const whole = sent.findLast(frame => frame.type === "snapshot")!;
  expect(whole.entries!.map(entry => entry.id)).toEqual([SESSION, "first-u", "first-a2", "first-r2", "first-a1", "first-r1", "first-a3"]);
  expect(lists(frames).at(-1)).toEqual(final!);
});

test("the session file holds a whole rewrite's bytes after every frame of two turns and a recovered result", async () => {
  setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
  let uuid = 0;
  const minted = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`);
  const truncate = spyOn(fs, "ftruncateSync"), open = spyOn(fs, "openSync");
  const path = join(sessionDir, `${SESSION}.jsonl`);
  const opensOfTranscript = () => open.mock.calls.filter(call => call[0] === path).length;
  try {
    const first = await runWorker("turn");
    truncate.mockClear();
    const firstReceipts = receiptsFor();
    const firstFiles = await readOnHost(first.frames, firstReceipts);
    expect(truncate.mock.calls.length, "PI_TEN_TOOL_TURN_TRUNCATES_AT_MOST_ONCE").toBeLessThanOrEqual(1);
    lists(first.frames).forEach((list, index) => {
      if (!list.some(entry => entry.type === "message")) expect(firstFiles[index]).toBeUndefined();
      else expect(firstFiles[index], `PI_TRANSCRIPT_FILE_AFTER_FRAME_${index}`).toBe(serialized(list));
    });
    expect(readPiSession(path) as Entry[]).toEqual(first.final!);
    const opened = opensOfTranscript();
    firstReceipts.persist();
    expect(opensOfTranscript(), "PI_PERSIST_WITHOUT_A_NEW_ENTRY_WRITES_NOTHING").toBe(opened);

    const resumed = readPiSession(path) as Entry[];
    const second = await runWorker("resume", { resume: true, entries: resumed });
    truncate.mockClear();
    const secondReceipts = receiptsFor(resumed.slice(1));
    const secondFiles = await readOnHost(second.frames, secondReceipts, new Set(resumed.map(entry => entry.id)));
    expect(truncate.mock.calls.length).toBeLessThanOrEqual(1);
    lists(second.frames).forEach((list, index) => expect(secondFiles[index], `PI_RESUMED_FILE_AFTER_FRAME_${index}`).toBe(serialized(list)));
    // The runtime left the last call unanswered; its committed effect is recovered once.
    secondReceipts.applications.set("second-call-4", { name: "brain_add", input: { content: "Ithaca" }, result: { ok: true } as never });
    secondReceipts.persist(true);
    const recovered = readPiSession(path) as Entry[];
    expect(recovered.slice(0, -1)).toEqual(second.final!);
    expect(recovered.at(-1)!.message).toMatchObject({ role: "toolResult", toolCallId: "second-call-4" });
    expect(readFileSync(path, "utf8")).toBe(serialized(recovered));
    // Captured from the tree before #4856 for the same script, time and identities.
    expect(readFileSync(path, "utf8").replaceAll(brain, "/odysseus/brain"))
      .toBe(readFileSync(join(import.meta.dir, "fixtures/transcript-two-turns.jsonl"), "utf8"));
    secondReceipts.persist(true);
    expect(readFileSync(path, "utf8"), "PI_SECOND_RECOVERY_ADDS_NO_LINE").toBe(serialized(recovered));
  } finally { minted.mockRestore(); truncate.mockRestore(); open.mockRestore(); setSystemTime(); }
});

test("a session file that differs from what the host saved is rewritten whole", async () => {
  const { frames } = await runWorker("turn");
  const sent = transcriptFrames(frames), path = join(sessionDir, `${SESSION}.jsonl`);
  const receipts = receiptsFor();
  await readOnHost(sent.slice(0, 3), receipts);
  expect(readFileSync(path, "utf8")).toBe(serialized(lists(sent)[2]!));
  fs.appendFileSync(path, '{"type":"message","id":"stray"}\n');
  receipts.latestEntries.push({ type: "message", id: "late", parentId: null, message: { role: "user", content: "Steer for Ithaca" } });
  receipts.persist();
  expect(readFileSync(path, "utf8"), "PI_MISMATCHED_SIZE_REWRITES_WHOLE").toBe(serialized(receipts.latestEntries));
});

test("the host refuses an append that does not extend the transcript it holds", async () => {
  const { frames } = await runWorker("turn");
  const sent = transcriptFrames(frames), receipts = receiptsFor();
  const skipped = [sent[0]!, sent[2]!];
  await expect(readOnHost(skipped, receipts)).rejects.toThrow("Pi worker sent a transcript append that does not extend its transcript");
  await expect(readOnHost([{ type: "transcript_append", base: 1, entries: sent[1]!.entries! }], receiptsFor()))
    .rejects.toThrow("Pi worker sent a transcript append that does not extend its transcript");
});

test("the host bounds appends by the size a whole snapshot of its transcript would have", async () => {
  const header = { type: "session", id: SESSION, cwd: brain };
  const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Sail" } };
  const filler = (id: string, size: number) => ({ type: "custom", id, data: "x".repeat(size) });
  const a = filler("f1", 1024 * 1024), b = filler("f2", 0);
  // The second append brings a whole snapshot to exactly the bound; no single frame comes near it.
  b.data = "x".repeat(PI_PIPE_MAX_BYTES - snapshotFrameBytes([header, user, a]) - Buffer.byteLength(JSON.stringify(b)) - 1);
  expect(snapshotFrameBytes([header, user, a, b])).toBe(PI_PIPE_MAX_BYTES);
  const frames = (last: typeof b): Frame[] => [{ type: "snapshot", entries: [header, user] },
    { type: "transcript_append", base: 2, entries: [a] }, { type: "transcript_append", base: 3, entries: [last] }];
  const receipts = receiptsFor();
  await readOnHost(frames(b), receipts);
  expect(receipts.latestEntries.map(entry => entry.id)).toEqual([SESSION, "u1", "f1", "f2"]);
  await expect(readOnHost(frames({ ...b, data: b.data + "x" }), receiptsFor()), "PI_HOST_BOUNDS_THE_WHOLE_TRANSCRIPT")
    .rejects.toBeInstanceOf(SessionTooLargeError);
});

test("a ten-round streamed turn holds all four per-turn counters at once (#5067)", async () => {
  const { frames, lines, final } = await runWorker("stream");
  // No transcript entry crosses the pipe twice.
  const seen = new Set<unknown>();
  for (const [index, frame] of transcriptFrames(frames).entries()) {
    const ids = frame.entries!.map(entry => entry.id);
    expect(ids.filter(id => seen.has(id)), `PI_STREAMED_TURN_FRAME_${index}_RESENDS_NO_ENTRY`).toEqual([]);
    ids.forEach(id => seen.add(id));
  }
  expect(lists(frames).at(-1)).toEqual(final!);
  // Every message_update frame is its delta plus one fixed envelope, however long the answer grows.
  const updates = lines.filter((_, i) => frames[i]!.type === "event" && frames[i]!.event!.type === "message_update");
  expect(updates).toHaveLength(30);
  const envelope = Buffer.byteLength(JSON.stringify({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } } }));
  for (const [index, line] of updates.entries()) {
    const delta = Buffer.byteLength(JSON.stringify((JSON.parse(line) as Frame).event!.assistantMessageEvent.delta)) - 2;
    expect(Buffer.byteLength(line), `PI_STREAMED_UPDATE_${index}_IS_ITS_DELTA_PLUS_AN_ENVELOPE`).toBeLessThanOrEqual(delta + envelope);
  }

  // The host records one application receipt per round, as the apply RPC does.
  const original = sdkInternal.sessionReplay, written: Entry[] = [];
  const replay = spyOn(sdkInternal, "sessionReplay").mockImplementation((...args: Parameters<typeof original>) => {
    const store = original(...args);
    return { ...store, retainReceipt(receipt: Parameters<typeof store.retainReceipt>[0]) { written.push(receipt); store.retainReceipt(receipt); } };
  });
  const truncate = spyOn(fs, "ftruncateSync");
  try {
    const receipts = receiptsFor();
    await readOnHost(frames, receipts, new Set(), event => {
      if (event.type !== "tool_execution_start") return;
      receipts.applications.set(event.toolCallId, { name: "brain_add", input: { content: event.toolCallId }, result: { ok: true } as never });
      receipts.persist();
    });
    expect(truncate.mock.calls.length, "PI_STREAMED_TURN_TRUNCATES_AT_MOST_ONCE").toBeLessThanOrEqual(1);
    expect(readPiSession(join(sessionDir, `${SESSION}.jsonl`)) as Entry[]).toEqual(final!);
    // Each receipt has one state: its call's assistant entry, its result. It is written once.
    const calls = Array.from({ length: 10 }, (_, i) => `first-call-${i + 1}`);
    expect(written.map(receipt => [receipt.id, receipt.anchor]), "PI_STREAMED_TURN_WRITES_EACH_RECEIPT_STATE_ONCE")
      .toEqual(calls.map((call, i) => [call, `first-a${i + 1}`]));
  } finally { replay.mockRestore(); truncate.mockRestore(); }
});
