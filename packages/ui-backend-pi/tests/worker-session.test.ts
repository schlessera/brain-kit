import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  expect(terminal(await turn())).toMatchObject({ outcome: "error", failure: { errorClass: "session_too_large" } });
  expect(launch).toHaveBeenCalledTimes(1);
});
test("growth reserve has a 1 MiB floor and scales to 25 percent", () => {
  expect(sessionReserveBytes(1)).toBe(MiB);
  expect(sessionReserveBytes(12 * MiB)).toBe(3 * MiB);
});
