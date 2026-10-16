import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Readable, Writable } from "node:stream";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../src/backend.js";
import { openPiWorkerSession } from "../src/worker-session.js";
import { savePiSession } from "../src/session-storage.js";
import { PI_PIPE_MAX_BYTES, PI_WORKER_STATE, sendPipe, sessionReserveBytes, SessionTooLargeError } from "../src/worker-protocol.js";

const ID = "11111111-1111-4111-8111-111111111111";
const MiB = 1024 * 1024;
let root: string, brain: string, sessionDir: string, previousAgentDir: string | undefined;
let launch: ReturnType<typeof spyOn>, probe: ReturnType<typeof spyOn>;
let receivedInit: any, overflow: boolean, publicationFailure: boolean;
const children: Array<() => void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-session-bound-"));
  brain = join(root, "brain"); sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  receivedInit = undefined; overflow = false; publicationFailure = false;
  probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const exited = Promise.withResolvers<number>();
    const stop = () => { stdout.end(); stderr.end(); if (publicationFailure) exited.reject(new Error("stale maintenance output: workspaces/shared.md")); else exited.resolve(0); };
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
test("Pi child overrides inherited agent directory while parent settings and copied state stay unchanged", async () => {
  const parentDir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(parentDir);
  const settings = JSON.stringify({ retry: { enabled: false } });
  writeFileSync(join(parentDir, "settings.json"), settings);
  expect(terminal(await turn(null))).toMatchObject({ outcome: "success" });
  expect(launch.mock.calls[0]![0].env.PI_CODING_AGENT_DIR, "PI_CHILD_OVERRIDES_INHERITED_AGENT_DIRECTORY").toBe(PI_WORKER_STATE);
  expect(process.env.PI_CODING_AGENT_DIR).toBe(parentDir);
  expect(receivedInit.agentFiles["settings.json"]).toBe(settings);
  expect(readFileSync(join(parentDir, "settings.json"), "utf8")).toBe(settings);
});
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
  mkdirSync(join(brain,".brain/scratch"),{recursive:true});
  writeFileSync(join(brain,".gitignore"),".brain/scratch/\n");
  const scratchReader = createFixtureWorkerStartupView(brain);
  children.push(() => { void scratchReader.cleanup(); });
  let closed = 0;
  launch.mockImplementation((input: worker.WorkerLaunch) => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const exited = Promise.withResolvers<number>();
    const stop = () => { stdout.end(); stderr.end(); if (publicationFailure) exited.reject(new Error("stale maintenance output: workspaces/shared.md")); else exited.resolve(0); };
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
  await createPiBackend({ brainPath: brain, sessionDir, maintenance: { startupView: scratchReader, tempDomain: { statePath: join(scratchReader.storage.root, "maintenance-state.db") } } }).startTurn({
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


test("Pi publication refusal fails the turn without unhandled lifecycle rejections", async () => {
  publicationFailure = true;
  const frames = await turn(null);
  expect(terminal(frames), "PI_PUBLICATION_REFUSAL_HANDLED").toMatchObject({ outcome: "error" });
  await Bun.sleep(10);
});
test("pi startup forwards trusted host admission and keeps it out of the worker init payload",async()=>{
 const maintenance={tempLimits:{allowanceBytes:8388608,budgetBytes:16777216},tempDomain:{statePath:join(root,"ui.db")},maskPaths:[join(root,"state")]};
 const prepare=worker.prepareWorkerSandbox;let seen:unknown;
 const capture=spyOn(worker,"prepareWorkerSandbox").mockImplementation((path,options)=>{seen=options?.maintenance;return prepare(path,options);});
 try{
  await createPiBackend({brainPath:brain,sessionDir,maintenance}).startTurn({prompt:"Return to Ithaca",signal:new AbortController().signal,
   bridge:{emit:()=>{},requestPermission:async()=>({behavior:"allow"})}});
  expect(seen,"PI_STARTUP_SHARED_ADMISSION").toEqual(maintenance);
  expect(JSON.stringify(receivedInit)).not.toContain(maintenance.tempDomain.statePath);
 }finally{capture.mockRestore();}
});

test("cancellation during native stage preparation never launches a late Pi worker", async () => {
  const controller = new AbortController(), entered = Promise.withResolvers<void>();
  const acquire = spyOn(worker,"prepareNativeWorkerOutput").mockImplementation(async (_brain, options) => {
    entered.resolve();
    expect(options.signal, "PI_NATIVE_PREPARATION_USES_TURN_CANCELLATION").toBe(controller.signal);
    return await new Promise<never>((_resolve,reject) => options.signal!.addEventListener("abort",() => reject(options.signal!.reason),{once:true}));
  });
  try {
    const startupView = {brain,root:brain,storage:{root:brain,retain(){},release(){}},cleanup(){}};
    const opening = openPiWorkerSession({brainPath:brain},sessionDir,{workerSignal:controller.signal,workerStartupView:startupView,
      workerSandbox:{profile:"strict",scratchAliasesRemoved:[],areas:[{name:"workspaces",rel:"workspaces",mount:{path:join(brain,"workspaces"),writable:true}}]} as never,
      caps:{askUser:false,askUserList:false,askUserRank:false,location:false,activity:false,mask:false}});
    await entered.promise;controller.abort(new Error("Odysseus cancelled native preparation"));
    await expect(opening).rejects.toThrow("Odysseus cancelled native preparation");
    expect(launch, "PI_CANCELLED_PREPARATION_NEVER_LAUNCHES").not.toHaveBeenCalled();
  } finally {controller.abort();acquire.mockRestore();}
});


for (const profile of ["governed", "strict"] as const) test(`throwing workerStarted kills and drains real Pi child before ${profile === "strict" ? "native output" : "governed"} cleanup`, async () => {
  const failure = Error("Fixture Pi scope freeze failed"), events: string[] = [];
  let process: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined, childExited = false;
  const baseline = worker.processStateLedger().turnTempHeld;
  let exited: Promise<number> | undefined;
  const view = { brain, root: brain, storage: { root: brain, retain() {}, release() {} }, cleanup() {} };
  const prepared = { view, output: { source: brain, storage: { root: brain, mount: brain, namespacePid: 1, allowanceBytes: MiB, retain() {}, release() {} } },
    async cleanup() { events.push("native-cleanup"); await exited; }, async publish() {}, async publishLocked() {} };
  const native = spyOn(worker, "prepareNativeWorkerOutput").mockResolvedValue(prepared);
  launch.mockImplementation(() => {
    process = Bun.spawn(["/bin/cat"], { cwd: root, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    children.push(() => { process?.kill("SIGKILL"); });
    exited = process.exited.then(code => { childExited = true; events.push("exited"); return code; });
    return { stdin: process.stdin, stdout: Readable.fromWeb(process.stdout as never), stderr: Readable.fromWeb(process.stderr as never), exited,
      kill() { events.push("killed"); process!.kill("SIGKILL"); }, limitReport: () => ({ hits: [], fatal: false }),
      turnTemp: { close() { events.push("turn-temp-close"); } } } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  const opening = openPiWorkerSession({ brainPath: brain }, sessionDir, { workerStartupView: profile === "strict" ? view : undefined,
    workerSandbox: { profile, scratchAliasesRemoved: [], areas: profile === "strict" ? [{ name: "workspaces", rel: "workspaces", mount: { path: join(brain, "workspaces"), writable: true } }] : [] } as never,
    workerStarted() { events.push("callback"); expect(worker.processStateLedger().turnTempHeld).toBeGreaterThan(baseline); throw failure; },
    caps: { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false } });
  const result = opening.then(() => undefined, error => error);
  try {
    const outcome = await Promise.race([result, Bun.sleep(1000).then(() => "pending")]);
    expect(childExited, "PI_WORKER_START_FAILURE_DRAINS_REAL_CHILD").toBe(true);
    expect(outcome, "PI_WORKER_START_FAILURE_PRESERVES_CALLBACK_ERROR").toBe(failure);
    expect(worker.processStateLedger().turnTempHeld, "PI_WORKER_START_FAILURE_RELEASES_RESERVATION").toBe(baseline);
    expect(events).toEqual(profile === "strict" ? ["callback", "killed", "exited", "turn-temp-close", "native-cleanup"] : ["callback", "killed", "exited", "turn-temp-close"]);
    expect(native).toHaveBeenCalledTimes(profile === "strict" ? 1 : 0);
    expect(receivedInit, "PI_WORKER_START_FAILURE_INITIALIZES_NO_PROVIDER").toBeUndefined();
  } finally { process?.kill("SIGKILL"); await exited; await result; native.mockRestore(); }
});

test("resuming a canonical transcript does not scan the session archive", async () => {
  save(1024);
  const sdk = await import("@earendil-works/pi-coding-agent");
  const list = spyOn(sdk.SessionManager, "list");
  try {
    expect(terminal(await turn())).toMatchObject({ outcome: "success" });
    expect(list, "PI_RESUME_READS_ONLY_SELECTED_TRANSCRIPT").not.toHaveBeenCalled();
  } finally { list.mockRestore(); }
});

test("legacy SDK transcript filenames remain resumable", async () => {
  save(1024);
  renameSync(join(sessionDir, `${ID}.jsonl`), join(sessionDir, `2026-07-12_${ID}.jsonl`));
  expect(terminal(await turn())).toMatchObject({ outcome: "success" });
  expect(receivedInit.entries[0]).toMatchObject({ type: "session", id: ID, cwd: brain });
});

test.each(["id", "cwd"])("canonical transcript refuses a mismatched %s before worker launch", async field => {
  save(1024);
  const path = join(sessionDir, `${ID}.jsonl`);
  const entries = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  entries[0][field] = "unrelated";
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await expect(openPiWorkerSession({ brainPath: brain }, sessionDir, { caps: { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false } }, undefined, ID))
    .rejects.toThrow("Cannot resume unknown session");
  expect(launch).not.toHaveBeenCalled();
});
