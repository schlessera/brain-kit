/**
 * Direct tests of the units openPiWorkerSession is assembled from (#2517):
 * receipt persistence and replay, the protocol reader and the worker's
 * lifecycle supervision, each without a worker process.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { LaunchedWorker, NativeFileVersions, Reservation, WorkerStateHandle } from "@schlessera/brain-ui-sdk/internal";

import type { SessionEnv } from "../src/backend-options";
import { readPiSession } from "../src/session-storage";
import { createTurnContext } from "../src/turn-context";
import { superviseWorker } from "../src/worker-launch";
import { sendPipe } from "../src/worker-protocol";
import { readPiWorkerProtocol, type PiWorkerTurnState } from "../src/worker-reader";
import { createPiWorkerReceipts } from "../src/worker-receipts";

const SESSION = "22222222-2222-4222-8222-222222222222";
let root: string, brain: string, sessionDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-worker-units-"));
  brain = join(root, "brain"); sessionDir = join(root, "sessions");
  mkdirSync(brain); mkdirSync(sessionDir);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const header = () => ({ type: "session", id: SESSION, cwd: brain });
const toolCall = (id: string) => ({ type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "Sailing." }, { type: "toolCall", id }] } });

function receipts(autonomous = false) {
  return createPiWorkerReceipts({ sessionDir, brainPath: brain, sessionId: SESSION, autonomous, entries: undefined, resumedIds: new Set(),
    turn: createTurnContext(), backend: {} });
}

test("persist recovers a committed call the runtime left unanswered with its own result", () => {
  const store = receipts();
  store.applications.set("call-1", { name: "brain_add", input: { content: "Ithaca" }, result: { ok: true } as never });
  store.latestEntries = [header(), toolCall("call-1")];
  store.persist();
  expect(store.applications.get("call-1")?.anchor).toBe("a1");
  expect(readPiSession(join(sessionDir, `${SESSION}.jsonl`))).toHaveLength(2);
  store.persist(true);
  const saved = readPiSession(join(sessionDir, `${SESSION}.jsonl`)) as Array<Record<string, any>>;
  expect(saved).toHaveLength(3);
  expect(saved[2]!.message).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "brain_add", isError: false });
  expect(store.answerText()).toBe("Sailing.");
});

test("an autonomous session persists nothing", () => {
  const store = receipts(true);
  store.applications.set("call-1", { name: "brain_add", input: {}, result: { ok: true } as never });
  store.latestEntries = [header(), toolCall("call-1")];
  store.persist(true);
  expect(existsSync(join(sessionDir, `${SESSION}.jsonl`))).toBe(false);
});

function fakeChild() {
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  const exited = Promise.withResolvers<number>();
  const child = { stdout, stderr, stdin, exited: exited.promise, kill: () => {}, released: async () => {},
    limitReport: () => ({ hits: [], fatal: false }) } as unknown as LaunchedWorker;
  return { child, stdout, stderr, stdin, exit: (code: number) => { stdout.end(); stderr.end(); exited.resolve(code); } };
}

test("the reader binds the worker's ready frame and refuses a protocol that closes before completion", async () => {
  const { child, stdout } = fakeChild();
  const state: PiWorkerTurnState = { active: false, initialized: false, ended: false, error: undefined, cost: 0,
    thinkingLevel: undefined, levels: [], model: undefined, ownedPrompt: undefined };
  const ready = Promise.withResolvers<void>();
  const reading = readPiWorkerProtocol({ child, state, ready, done: Promise.withResolvers<void>(), sessionId: SESSION, backend: { brainPath: brain },
    startupStarted: 0, promptContext: undefined, sessionBudgetLimits: undefined, autonomous: false, resumed: false, turnContext: createTurnContext(),
    nativeVersions: {} as NativeFileVersions, receipts: receipts(), resumedIds: new Set(), listeners: new Set(),
    proof: { started: () => {}, ended: () => undefined }, toolExecution: undefined, dispatch: async () => undefined, send: () => {},
    fail: () => {}, reportLimitHits: () => {}, limitEnded: async () => undefined, diagnostic: () => "" });
  sendPipe(stdout, { type: "ready", sessionId: SESSION, levels: ["low", "high"], cost: 0.25 });
  stdout.end();
  await ready.promise;
  expect(state).toMatchObject({ initialized: true, cost: 0.25, levels: ["low", "high"] });
  await expect(reading).rejects.toThrow("Pi worker exited before completion: protocol closed");
});

test("supervision frees an unprompted worker's turn temp once on exit, and releases its locks", async () => {
  const { child, stderr, exit } = fakeChild();
  let closed = 0, released = 0, unlocked = 0;
  const turnTemp = { root: join(root, "tmp"), closeAsync: async () => { closed++; } } as unknown as WorkerStateHandle;
  const reservation = { turnTempBytes: 1024, release: () => { released++; } } as unknown as Reservation;
  const supervision = superviseWorker({ child, reservation, turnTemp, env: { caps: {} } as SessionEnv, turnContext: createTurnContext(),
    admission: { envelope: undefined, hostInference: undefined }, answerText: () => "" });
  supervision.releases.set("lock-a", () => { unlocked++; });
  stderr.write("Scylla on the left");
  exit(0);
  await child.exited; await Bun.sleep(0);
  expect(supervision.diagnostic()).toBe("Scylla on the left");
  expect({ closed, released, unlocked }).toEqual({ closed: 1, released: 1, unlocked: 1 });
  await supervision.closeTurnTemp();
  expect({ closed, released }).toEqual({ closed: 1, released: 1 });
});

test("a prompted worker leaves its turn temp to promotion", async () => {
  const { child, exit } = fakeChild();
  let closed = 0;
  const turnTemp = { root: join(root, "tmp"), closeAsync: async () => { closed++; } } as unknown as WorkerStateHandle;
  const supervision = superviseWorker({ child, reservation: { turnTempBytes: 1, release: () => {} } as unknown as Reservation, turnTemp,
    env: { caps: {} } as SessionEnv, turnContext: createTurnContext(), admission: { envelope: undefined, hostInference: undefined }, answerText: () => "" });
  supervision.markPrompted();
  exit(0);
  await child.exited; await Bun.sleep(0);
  expect(closed).toBe(0);
});
