import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend.js";
import { openPiWorkerSession } from "../src/worker-session.js";
import { savePiSession } from "../src/session-storage.js";
import { PI_PIPE_MAX_BYTES, sendPipe, sessionReserveBytes, SessionTooLargeError } from "../src/worker-protocol.js";

const ID = "11111111-1111-4111-8111-111111111111";
const MiB = 1024 * 1024;
let root: string, brain: string, sessionDir: string, previousAgentDir: string | undefined;
let launch: ReturnType<typeof spyOn>, probe: ReturnType<typeof spyOn>;
let receivedInit: any, overflow: boolean;
const children: Array<() => void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-session-bound-"));
  brain = join(root, "brain"); sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  receivedInit = undefined; overflow = false;
  probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const exited = Promise.withResolvers<number>();
    const stop = () => { stdout.end(); stderr.end(); exited.resolve(0); };
    children.push(stop);
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk));
      if (message.type === "init") {
        receivedInit = message;
        sendPipe(stdout, { type: "ready", sessionId: message.sessionId, levels: [], cost: 0 });
      } else if (message.type === "prompt") {
        if (overflow) {
          // Exercise the same bounded sender and typed error frame as the worker.
          try { sendPipe(stdout, { type: "snapshot", entries: [{ text: "x".repeat(PI_PIPE_MAX_BYTES) }] }); }
          catch (error) {
            if (!(error instanceof SessionTooLargeError)) throw error;
            sendPipe(stdout, { type: "error", message: error.message, errorClass: error.errorClass });
          }
        } else sendPipe(stdout, { type: "done", cost: 0 });
      }
      callback();
    } });
    return { stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
});
afterEach(() => {
  for (const stop of children.splice(0)) stop();
  launch.mockRestore(); probe.mockRestore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});
function save(bytes: number) {
  savePiSession(sessionDir, ID, [
    { type: "session", version: 3, id: ID, cwd: brain, timestamp: "2026-07-12T00:00:00.000Z" },
    { type: "message", id: "odysseus", parentId: null, timestamp: "2026-07-12T00:00:00.000Z",
      message: { role: "user", content: "x".repeat(bytes), timestamp: 0 } },
  ]);
}
async function turn(sessionId: string | null = ID) {
  const frames: ServerMessage[] = [];
  await createPiBackend({ brainPath: brain, sessionDir }).startTurn({
    sessionId: sessionId ?? undefined, prompt: "Return to Ithaca", signal: new AbortController().signal,
    bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) },
  });
  return frames;
}
function terminal(frames: ServerMessage[]) {
  const results = frames.filter(f => f.type === "result");
  expect(results).toHaveLength(1);
  return results[0]!;
}
for (const bytes of [17 * MiB, 13 * MiB]) test(`oversized session refuses before any worker launch (${bytes})`, async () => {
  save(bytes);
  await expect(openPiWorkerSession({ brainPath: brain }, sessionDir, { caps: { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false } }, undefined, ID))
    .rejects.toMatchObject({ errorClass: "session_too_large" });
  expect(launch).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(terminal(await turn())).toMatchObject({ outcome: "error", failure: { errorClass: "session_too_large" } });
  expect(launch).not.toHaveBeenCalled();
});
test("near-bound session with its growth reserve still runs", async () => {
  save(12 * MiB);
  expect(terminal(await turn())).toMatchObject({ outcome: "success" });
  expect(launch).toHaveBeenCalledTimes(1);
  const bytes = Buffer.byteLength(JSON.stringify(receivedInit) + "\n");
  expect(bytes).toBeGreaterThan(12 * MiB);
  expect(bytes + sessionReserveBytes(bytes)).toBeLessThan(PI_PIPE_MAX_BYTES);
});
for (const bytes of [6 * MiB, 10 * MiB]) test(`resumed state observation and agent note share the unchanged admission payload (${bytes})`, async () => {
  save(bytes);
  const result = terminal(await turn());
  const { sandboxNote, ...admissionInput } = receivedInit;
  const payloadBytes = Buffer.byteLength(JSON.stringify(admissionInput) + "\n");
  const usedBytes = payloadBytes + sessionReserveBytes(payloadBytes);
  expect(result, "PI_STATE_ROOM_FROM_ADMISSION_INPUT").toHaveProperty("stateRoom", {
    usedBytes, allowanceBytes: 16 * MiB, observedAt: expect.any(Number),
  });
  expect(sandboxNote.includes("This conversation is nearing its saved-state limit:")).toBe(bytes === 10 * MiB);
  if (bytes === 10 * MiB) expect(sandboxNote).toContain("Continue in a new conversation before it is full. This one stays available.");
  expect(launch).toHaveBeenCalledTimes(1);
});
test("initialization size includes native settings and UTF-8 bytes", async () => {
  save(1);
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ text: "Ω".repeat(7 * MiB) }));
  expect(terminal(await turn())).toMatchObject({ failure: { errorClass: "session_too_large" } });
  expect(launch).not.toHaveBeenCalled();
  const fresh = await turn(null);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ type: "error", failure: { errorClass: "session_too_large" } });
  expect(launch).not.toHaveBeenCalled();
});
test("snapshot overflow reaches the terminal TurnFailure", async () => {
  save(1); overflow = true;
  const result = terminal(await turn());
  expect(result).toMatchObject({ outcome: "error", failure: { errorClass: "session_too_large" } });
  expect(result.stateRoom).toBeUndefined();
  expect(launch).toHaveBeenCalledTimes(1);
});
test("a turn's linked turn-temp file is promoted into scratch and the saved answer links the copy (#1655)", async () => {
  const turnId = "0b7e3c1a-4f2d-4c6b-8a9e-1d2c3b4a5f60";
  const answer = "The voyage report is [ready](/tmp/brain-worker-scratch/report.pdf). Not [this](/tmp/brain-worker-scratch/pi-state/auth.json).";
  // Stands in for the worker's private /tmp, as the server holds it (#1703).
  const tmp = mkdtempSync(join(tmpdir(), "pi-turn-temp-"));
  let closed = 0;
  launch.mockImplementation((input: worker.WorkerLaunch) => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const exited = Promise.withResolvers<number>();
    const stop = () => { stdout.end(); stderr.end(); exited.resolve(0); };
    children.push(stop);
    expect(input.turnTempBytes).toBe(worker.DEFAULT_TURN_TEMP_BYTES);
    expect(worker.processStateLedger().turnTempHeld).toBe(worker.DEFAULT_TURN_TEMP_BYTES);
    let sessionId = "";
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk));
      if (message.type === "init") {
        sessionId = message.sessionId;
        sendPipe(stdout, { type: "ready", sessionId, levels: [], cost: 0 });
      } else if (message.type === "prompt") {
        // What a real worker's write to $BRAIN_WORKER_SCRATCH lands on: its private /tmp.
        mkdirSync(join(tmp, "brain-worker-scratch"), { recursive: true });
        writeFileSync(join(tmp, "brain-worker-scratch/report.pdf"), "Odysseus: the voyage report.");
        mkdirSync(join(tmp, "brain-worker-scratch/pi-state"));
        writeFileSync(join(tmp, "brain-worker-scratch/pi-state/auth.json"), "{}");
        sendPipe(stdout, { type: "snapshot", entries: [
          { type: "session", version: 3, id: sessionId, cwd: brain, timestamp: "2026-07-12T00:00:00.000Z" },
          { type: "message", id: "u1", parentId: null, timestamp: "2026-07-12T00:00:00.000Z", message: { role: "user", content: "Report?", timestamp: 0 } },
          { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-12T00:00:01.000Z",
            message: { role: "assistant", content: [{ type: "text", text: answer }], model: "odysseus-1", stopReason: "stop", timestamp: 1,
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
        ] });
        sendPipe(stdout, { type: "done", cost: 0 });
      }
      callback();
    } });
    return { stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }),
      turnTemp: { root: tmp, space: () => ({ total: 0, free: 0 }), close: () => { closed++; } } } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  const events: unknown[] = [], frames: ServerMessage[] = [];
  await createPiBackend({ brainPath: brain, sessionDir }).startTurn({
    prompt: "Write up the voyage report", signal: new AbortController().signal, turnId,
    bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }), activity: event => events.push(event) },
  });
  expect(terminal(frames)).toMatchObject({ outcome: "success" });
  const destination = `.brain/scratch/turns/${turnId}/report.pdf`;
  expect(readFileSync(join(brain, destination), "utf8")).toBe("Odysseus: the voyage report.");
  const saved = readFileSync(join(sessionDir, readdirSync(sessionDir).find(name => name.endsWith(".jsonl"))!), "utf8");
  expect(saved).toContain(`The voyage report is [ready](${destination}).`);
  expect(saved).not.toContain("[ready](/tmp/");
  // Runtime state in turn temp (the login) is never promoted.
  expect(saved).toContain("[this](/tmp/brain-worker-scratch/pi-state/auth.json)");
  expect(events).toEqual([{ kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination, bytes: 28,
    originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: destination }]);
  // The server lets go of the worker's turn temp once the turn has ended, and
  // its admission is released.
  expect(closed).toBe(1);
  expect(worker.processStateLedger().turnTempHeld).toBe(0);
  rmSync(tmp, { recursive: true, force: true });
});
test("growth reserve has a 1 MiB floor and scales to 25 percent", () => {
  expect(sessionReserveBytes(1)).toBe(MiB);
  expect(sessionReserveBytes(12 * MiB)).toBe(3 * MiB);
});
