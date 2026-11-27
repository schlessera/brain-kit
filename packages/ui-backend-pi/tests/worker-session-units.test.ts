/**
 * Direct tests of the units openPiWorkerSession is assembled from (#2517):
 * receipt persistence and replay, the protocol reader and the worker's
 * lifecycle supervision, each without a worker process.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import * as sdkInternal from "@schlessera/brain-ui-sdk/internal";
import type { LaunchedWorker, NativeFileVersions, Reservation, WorkerStateHandle } from "@schlessera/brain-ui-sdk/internal";

import type { SessionEnv } from "../src/backend-options";
import { readPiSession } from "../src/session-storage";
import { createTurnContext } from "../src/turn-context";
import { superviseWorker } from "../src/worker-launch";
import { PiInputSafetyUnavailableError, sendPipe } from "../src/worker-protocol";
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

type ReplayReceipt = Parameters<ReturnType<typeof sdkInternal.sessionReplay>["retainReceipt"]>[0];
/** Counts the receipts persist() writes to the replay file; `failNext` makes the next write throw. */
function spyRetains() {
  const original = sdkInternal.sessionReplay, written: ReplayReceipt[] = [], control = { failNext: false };
  const spy = spyOn(sdkInternal, "sessionReplay").mockImplementation((...args: Parameters<typeof original>) => {
    const store = original(...args);
    return { ...store, retainReceipt(receipt: ReplayReceipt) {
      if (control.failNext) { control.failNext = false; throw new Error("The replay disk is full"); }
      written.push(receipt); store.retainReceipt(receipt);
    } };
  });
  return { written, control, restore: () => spy.mockRestore() };
}
const assistantCalling = (ids: string[]) => ({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant",
  content: [{ type: "text", text: "Sailing." }, ...ids.map(id => ({ type: "toolCall", id }))] } });
const userTurn = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Steer past Scylla." } };

test("persist retains each receipt once while it is unchanged", () => {
  const spy = spyRetains();
  try {
    const store = receipts(), ids = ["c1", "c2", "c3", "c4", "c5"];
    for (const id of ids) store.applications.set(id, { name: "brain_add", input: { content: id }, result: { ok: true } as never });
    store.latestEntries = [header(), userTurn, assistantCalling(ids)];
    store.persist();
    expect(spy.written).toHaveLength(5);
    for (let i = 0; i < 20; i++) store.persist();
    expect(spy.written, "PI_RECEIPT_RETAINED_ONLY_WHEN_CHANGED").toHaveLength(5);
  } finally { spy.restore(); }
});

test("persist retains a receipt again when its anchor or its output changes", () => {
  const spy = spyRetains();
  try {
    const store = receipts();
    store.applications.set("c1", { name: "brain_add", input: { content: "Ithaca" }, result: { ok: true } as never });
    store.latestEntries = [header(), userTurn];
    store.persist();
    expect(spy.written.map(r => r.anchor)).toEqual(["u1"]);
    store.latestEntries = [header(), userTurn, assistantCalling(["c1"])];
    store.persist();
    expect(spy.written.map(r => r.anchor), "PI_RECEIPT_RETAINED_ON_ANCHOR_CHANGE").toEqual(["u1", "a1"]);
    store.applications.get("c1")!.output = { content: [{ type: "text", text: "Added to the log." }], details: undefined } as never;
    store.persist();
    expect(spy.written.map(r => [r.output, r.isError]), "PI_RECEIPT_RETAINED_ON_OUTPUT_CHANGE")
      .toEqual([['{"ok":true}', false], ['{"ok":true}', false], ["Added to the log.", false]]);
    store.applications.set("c1", { name: "brain_add", input: { content: "Ithaca" }, result: { ok: false } as never });
    store.persist();
    expect(spy.written.at(-1)).toMatchObject({ output: '{"ok":false}', isError: true });
    expect(spy.written).toHaveLength(4);
  } finally { spy.restore(); }
});

test("a receipt whose write failed is retained by the next persist", () => {
  const spy = spyRetains();
  try {
    const store = receipts();
    store.applications.set("c1", { name: "brain_add", input: { content: "Ithaca" }, result: { ok: true } as never });
    store.latestEntries = [header(), userTurn, assistantCalling(["c1"])];
    spy.control.failNext = true;
    expect(() => store.persist()).toThrow("The replay disk is full");
    expect(spy.written).toHaveLength(0);
    store.persist();
    expect(spy.written.map(r => r.id), "PI_RECEIPT_RETRIED_AFTER_FAILED_WRITE").toEqual(["c1"]);
  } finally { spy.restore(); }
});

test("a scripted turn stores the same replay receipts", () => {
  const store = receipts();
  store.latestEntries = [header(), userTurn];
  store.applications.set("c1", { name: "brain_add", input: { content: "Ithaca" }, result: { ok: true } as never });
  store.persist();
  store.latestEntries = [header(), userTurn, assistantCalling(["c1", "c2"])];
  store.persist();
  store.applications.set("c2", { name: "brain_update", input: { path: "voyage.md" }, result: { ok: false } as never });
  store.persist();
  store.applications.get("c1")!.output = { content: [{ type: "text", text: "Added to the log." }, { type: "image" }, { type: "text", text: " Again." }], details: undefined } as never;
  store.persist();
  store.persist(true);
  const stored = sdkInternal.sessionReplay(sessionDir, brain, SESSION).receipts();
  expect(new Set(stored.map(r => r.turnId)).size).toBe(1);
  // Captured from the tree before #4855, without the per-turn random id.
  expect(stored.map(({ turnId: _turnId, ...rest }) => rest)).toEqual([
    { id: "c1", name: "brain_add", input: { content: "Ithaca" }, anchor: "a1", output: "Added to the log. Again.", isError: false },
    { id: "c2", name: "brain_update", input: { path: "voyage.md" }, anchor: "a1", output: '{"ok":false}', isError: true },
  ]);
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
    proof: { loaded: () => {}, started: () => {}, ended: () => undefined }, toolExecution: undefined, dispatch: async () => undefined, send: () => {},
    fail: () => {}, reportLimitHits: () => {}, limitEnded: async () => undefined, diagnostic: () => "" });
  sendPipe(stdout, { type: "ready", sessionId: SESSION, levels: ["low", "high"], cost: 0.25 });
  stdout.end();
  await ready.promise;
  expect(state).toMatchObject({ initialized: true, cost: 0.25, levels: ["low", "high"] });
  await expect(reading).rejects.toThrow("Pi worker exited before completion: protocol closed");
});

test("startup collector loss crosses the real pipe reader without an active-turn RPC",async()=>{
 const {child,stdout}=fakeChild();let rpcs=0,answers=0;
 const state:PiWorkerTurnState={active:false,initialized:false,ended:false,error:undefined,cost:0,thinkingLevel:undefined,levels:[],model:undefined,ownedPrompt:undefined};
 const reading=readPiWorkerProtocol({child,state,ready:Promise.withResolvers<void>(),done:Promise.withResolvers<void>(),sessionId:SESSION,backend:{brainPath:brain},
  startupStarted:0,promptContext:undefined,sessionBudgetLimits:undefined,autonomous:false,resumed:false,turnContext:createTurnContext(),
  nativeVersions:{} as NativeFileVersions,receipts:receipts(),resumedIds:new Set(),listeners:new Set(),proof:{loaded(){},started(){},ended(){return undefined;}},
  toolExecution:undefined,dispatch:async()=>{rpcs++;throw new Error("No active turn");},send(){answers++;},fail(){},reportLimitHits(){},limitEnded:async()=>undefined,diagnostic:()=>""});
 sendPipe(stdout,{type:"error",errorClass:"input_safety_unavailable",message:"Unqualified voyage extension"});stdout.end();
 const refusal=await reading.then(()=>undefined,error=>error);
 expect(refusal,"PI_STARTUP_ONE_WAY_LOSS_SIGNAL_REACHES_HOST").toBeInstanceOf(PiInputSafetyUnavailableError);
 expect({rpcs,answers},"PI_STARTUP_LOSS_NEVER_WAITS_FOR_AN_RPC_ANSWER").toEqual({rpcs:0,answers:0});
 expect(state.initialized).toBe(false);
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
  supervision.claimTurnTempClose();
  exit(0);
  await child.exited; await Bun.sleep(0);
  expect(closed).toBe(0);
});
