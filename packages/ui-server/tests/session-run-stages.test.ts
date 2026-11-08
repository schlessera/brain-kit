import { afterEach, describe, expect, test } from "bun:test";
import type { BudgetObservation, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { BackendRequestError, type AgentBackend } from "@schlessera/brain-ui-sdk/server";

import { createStaticBackendRegistry, type BackendRegistry } from "../src/agent/backend";
import { BudgetExceeded, BudgetUnavailable } from "../src/brain/turn-budgets";
import { createRecordingObservability } from "../src/observability/index";
import { resolveTurnTarget } from "../src/ws/routing";
import type { WSContext } from "../src/ws/clients";
import { WsHost } from "../src/ws/host";
import type { SessionCatalog } from "../src/ws/session-catalog";
import { REVOKED_REASON, type AuthorizationContext, type HostWork, type QueuedFollowUp } from "../src/ws/turns";
import { admitWorkerHost, announceTurnStart, armTurnTimeout } from "../src/ws/session-run/admission";
import { recordDraftExchanges, turnRequest } from "../src/ws/session-run/backend-entry";
import { budgetAttribution, budgetEvent, createTurnBudget, settleBudgetWrites, type BudgetAttribution } from "../src/ws/session-run/budget";
import {
  AdmissionRevoked,
  classifyCompletedTurn,
  classifyFailedTurn,
  type FailedTurnFacts,
  type TurnFacts,
} from "../src/ws/session-run/outcome";
import {
  bindRequest,
  closeSessionSlot,
  dequeueRequest,
  dropHandedOver,
  beginSlotStart,
  firstRequest,
  registerSessionSlot,
  releaseActive,
  reportRoutingFailure,
  SLOT_ENDED_REASON,
} from "../src/ws/session-run/slot";
import { publishTurnStatus } from "../src/ws/session-run/teardown";
import { runSlotTurn } from "../src/ws/session-run/turn";
import type { SessionSlot, TurnRun } from "../src/ws/session-run/types";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

const AUTHORIZATION = testAuthorization();

function catalog(): SessionCatalog {
  return {
    getStoredProviderId: () => null,
    getStoredBackendId: () => null,
    persistSessionStub() {},
    persistSession() {},
  };
}

function setupHost(backend: AgentBackend = makeFakeBackend({ id: "fake" }), options: { registry?: BackendRegistry; catalog?: SessionCatalog; turnTimeoutMs?: number } = {}) {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send(data) { sent.push(JSON.parse(data) as ServerMessage); } };
  const host = new WsHost({
    registry: options.registry ?? createStaticBackendRegistry([backend], backend.id),
    catalog: options.catalog ?? catalog(),
    observability: createRecordingObservability(),
    turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
  });
  host.clients.add(ws, AUTHORIZATION.principalId);
  return { host, sent };
}

/** A queue lease that counts its releases. */
function countedAuthorization(valid = true): AuthorizationContext & { releases: number } {
  const authorization = { ...testAuthorization(), valid, releases: 0 } as AuthorizationContext & { releases: number };
  authorization.retain = () => () => { authorization.releases += 1; };
  return authorization;
}

function queued(text: string, authorization: AuthorizationContext = AUTHORIZATION, extra: Partial<QueuedFollowUp> = {}): QueuedFollowUp & { released: number } {
  const entry = {
    principalId: authorization.principalId,
    authorization,
    text,
    attachments: [],
    released: 0,
    releaseAuthorization: () => { entry.released += 1; },
    ...extra,
  } as QueuedFollowUp & { released: number };
  return entry;
}

function recordingWork(posture?: "voice"): HostWork & { settled: Array<[string, unknown]>; startedWith: string[] } {
  const work = {
    settled: [] as Array<[string, unknown]>,
    startedWith: [] as string[],
    ...(posture ? { posture } : {}),
    started(turnId: string) { work.startedWith.push(turnId); },
    settle(outcome: string, detail: unknown) { work.settled.push([outcome, detail]); },
    observe() {},
  };
  return work as unknown as HostWork & { settled: Array<[string, unknown]>; startedWith: string[] };
}

/** Replace one method on an instance and restore its exact descriptor afterwards. */
const restores: Array<() => void> = [];
function spyOn<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
  restores.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<PropertyKey, unknown>)[key as PropertyKey];
  });
}
afterEach(() => { while (restores.length) restores.pop()!(); });

type SlotInput = Parameters<typeof registerSessionSlot>[1];

/** Route and register a slot the way runRetainedSession does. */
async function openSlot(host: WsHost, input: Partial<SlotInput> = {}): Promise<SessionSlot> {
  const initial: SlotInput = { authorization: AUTHORIZATION, text: "hello", attachments: [], ...input };
  const starting = beginSlotStart(host, initial);
  let target: Awaited<ReturnType<typeof resolveTurnTarget>>;
  try { target = await resolveTurnTarget(host.registry, host.catalog, initial.sessionId, initial.providerId); }
  finally { host.coordinator.endStarting(initial.sessionId, starting); }
  const slot = registerSessionSlot(host, initial, starting, target, "turn-1");
  if (!slot) throw new Error("the slot did not open");
  return slot;
}

const OBSERVATION: BudgetObservation = {
  scope: "turn", costUsd: 2, tokens: 900, unknownRuns: 0,
  warnUsd: 1, blockUsd: 5, blockTokens: 10_000, warnTokens: 800, warning: true, blocked: false,
};
const ATTRIBUTION: BudgetAttribution = { turnId: "turn-1", sessionId: "session-1", actor: "interactive", model: "model-a", profile: "governed", source: "policy" };

describe("outcome classification", () => {
  const facts = (overrides: Partial<TurnFacts> = {}): TurnFacts => ({ cancelled: false, aborted: false, lastResult: "success", stops: {}, ...overrides });
  const failed = (overrides: Partial<FailedTurnFacts> = {}): FailedTurnFacts => ({
    ...facts(), error: new Error("boom"), egressFailure: undefined, enteredBackend: true, ...overrides,
  });

  test("a completed turn reads success, a reported result error, cancellation and timeout", () => {
    expect(classifyCompletedTurn(facts())).toEqual({ lifecycle: "success", work: "completed", cancelledBeforeStart: false, recorder: "success", resultFailed: false });
    expect(classifyCompletedTurn(facts({ lastResult: "error" }))).toMatchObject({ lifecycle: "error", work: "error", resultFailed: true });
    expect(classifyCompletedTurn(facts({ lastResult: "cancelled" }))).toMatchObject({ lifecycle: "success", work: "cancelled" });
    expect(classifyCompletedTurn(facts({ cancelled: true, aborted: true }))).toMatchObject({ lifecycle: "cancelled", work: "cancelled" });
    expect(classifyCompletedTurn(facts({ cancelled: true, aborted: true })).reason).toBeUndefined();
    expect(classifyCompletedTurn(facts({ aborted: true }))).toMatchObject({ lifecycle: "timeout", recorder: "timeout", work: "cancelled", reason: "Turn timed out" });
  });

  test("a completed turn stopped by a scope cap keeps the cap's reason", () => {
    expect(classifyCompletedTurn(facts({ cancelled: true, aborted: true, stops: { scope: "Tool call cap reached" } })))
      .toMatchObject({ lifecycle: "cancelled", work: "cancelled", reason: "Tool call cap reached" });
  });

  test("a cancel or revocation during admission is cancelled before start, with no error frame", () => {
    const cancelled = classifyFailedTurn(failed({ cancelled: true, enteredBackend: false }));
    expect(cancelled).toMatchObject({ delivery: "cancelled_before_start", cancelledBeforeStart: true, lifecycle: "cancelled", work: "cancelled", reason: "boom" });
    const revoked = classifyFailedTurn(failed({ error: new AdmissionRevoked(), enteredBackend: false }));
    expect(revoked).toMatchObject({ delivery: "cancelled_before_start", lifecycle: "cancelled", recorder: "cancelled", work: "cancelled", reason: REVOKED_REASON });
    // Once the backend was entered, the same cancel is reported.
    expect(classifyFailedTurn(failed({ cancelled: true })).delivery).toBe("reported");
  });

  test("an asynchronous stop wins over the error that unwound the turn, budget first", () => {
    const budget = new BudgetUnavailable();
    const journal = new Error("journal storage failed");
    const egress = new Error("egress record failed");
    const both = classifyFailedTurn(failed({ aborted: true, stops: { budget, journal }, egressFailure: egress }));
    expect(both).toMatchObject({ terminal: budget, delivery: "reported", lifecycle: "error", work: "error", reason: budget.message, budgetUnavailable: true });
    const journalOnly = classifyFailedTurn(failed({ aborted: true, stops: { journal }, egressFailure: egress }));
    expect(journalOnly).toMatchObject({ terminal: journal, lifecycle: "error", work: "error", reason: journal.message, budgetUnavailable: false });
    expect(classifyFailedTurn(failed({ aborted: true, egressFailure: egress }))).toMatchObject({ terminal: egress, lifecycle: "error", work: "error" });
  });

  test("a timeout is cancelled host work that keeps its reason", () => {
    expect(classifyFailedTurn(failed({ aborted: true }))).toMatchObject({ delivery: "reported", lifecycle: "timeout", recorder: "timeout", work: "cancelled", reason: "Turn timed out" });
  });

  test("a scope stop already narrated is not reported again unless something else failed", () => {
    expect(classifyFailedTurn(failed({ cancelled: true, aborted: true, stops: { scope: "cap" } })))
      .toMatchObject({ delivery: "scope_stopped", lifecycle: "cancelled", work: "cancelled", cancelledBeforeStart: false });
    expect(classifyFailedTurn(failed({ cancelled: true, aborted: true, stops: { scope: "cap" }, egressFailure: new Error("egress") })).delivery).toBe("reported");
  });

  test("an admission budget block is denied in Activity and an error for the work", () => {
    const block = new BudgetExceeded(OBSERVATION, "admission");
    const outcome = classifyFailedTurn(failed({ error: block, enteredBackend: false }));
    expect(outcome).toMatchObject({ admissionBlock: block, lifecycle: "denied", recorder: "error", work: "error", delivery: "reported" });
    const midTurn = new BudgetExceeded(OBSERVATION, "mid_turn");
    expect(classifyFailedTurn(failed({ stops: { budget: midTurn } }))).toMatchObject({ admissionBlock: undefined, lifecycle: "error" });
  });

  test("a non-Error terminal reports its string form", () => {
    expect(classifyFailedTurn(failed({ error: "plain" })).reason).toBe("plain");
  });
});

describe("budget events", () => {
  test("a warning reports dollars once its cost crosses the warning, otherwise tokens", () => {
    expect(budgetEvent("budget_warning", OBSERVATION, ATTRIBUTION)).toEqual({
      kind: "budget_warning", turnId: "turn-1", sessionId: "session-1", actor: "interactive", model: "model-a", profile: "governed",
      payload: { scope: "turn", unit: "usd", limit: 1, observed: 2, source: "policy" },
    });
    expect(budgetEvent("budget_warning", { ...OBSERVATION, costUsd: null }, ATTRIBUTION).payload)
      .toEqual({ scope: "turn", unit: "tokens", limit: 800, observed: 900, source: "policy" });
  });

  test("a block names its stage; the SDK backstop is always dollars", () => {
    expect(budgetEvent("budget_block", OBSERVATION, ATTRIBUTION, "mid_turn").payload)
      .toEqual({ scope: "turn", unit: "tokens", limit: 10_000, observed: 900, source: "policy", stage: "mid_turn" });
    expect(budgetEvent("budget_block", { ...OBSERVATION, costUsd: 6 }, ATTRIBUTION, "admission").payload)
      .toEqual({ scope: "turn", unit: "usd", limit: 5, observed: 6, source: "policy", stage: "admission" });
    expect(budgetEvent("budget_block", { ...OBSERVATION, costUsd: null }, ATTRIBUTION, "sdk_backstop").payload)
      .toEqual({ scope: "turn", unit: "usd", limit: 5, observed: 0, source: "policy", stage: "sdk_backstop" });
  });

  test("attribution is read from the live turn, and an unheld turn records strict defaults", () => {
    const run = { turn: { turnId: "turn-2", sessionId: null }, origin: "voice", mainModel: null, held: {} } as unknown as TurnRun;
    expect(budgetAttribution(run)).toEqual({ turnId: "turn-2", sessionId: null, actor: "voice", model: null, profile: "strict", source: "default" });
  });
});

describe("turn budget accounting", () => {
  function budgetRun(budgets: Record<string, unknown>) {
    const { host, sent } = setupHost();
    const governance: unknown[] = [];
    const stops: Record<string, unknown> = {};
    const abortController = new AbortController();
    const recorded: unknown[][] = [];
    Object.defineProperty(host, "budgets", { configurable: true, value: budgets });
    Object.defineProperty(host, "activity", { configurable: true, value: { governance: (event: unknown) => governance.push(event) } });
    const run = {
      host, turn: { turnId: "turn-1", sessionId: "session-1", cancelled: false }, origin: "interactive", mainModel: "model-a",
      held: { governedHold: { sandbox: { profile: "governed" }, policy: { hash: "abc" } } },
      abortController, stops, budgetWrites: new Set<Promise<unknown>>(),
      recorder: { recordBudgetStop: (...args: unknown[]) => recorded.push(args) },
    } as unknown as TurnRun;
    return { run, sent, governance, stops, abortController, recorded };
  }

  test("an observed block stops the turn after its write commits", async () => {
    const { run, sent, governance, stops, abortController, recorded } = budgetRun({
      observe: async () => ({ warnings: [OBSERVATION], blocked: { ...OBSERVATION, tokens: 20_000 }, receipt: { listPriceCostUsd: 1.5, observedAt: 7 } }),
      listPrice: () => 1.25,
    });
    const budget = createTurnBudget(run);
    expect(budget.observeUsage({ inputTokens: 10, outputTokens: 5, costUsd: 9 } as never)).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 1.25 } as never);
    expect(abortController.signal.aborted).toBe(false);
    await settleBudgetWrites(run);
    expect(governance.map(event => (event as { kind: string }).kind)).toEqual(["budget_warning", "budget_block"]);
    expect(sent.find(frame => frame.type === "usage")).toMatchObject({ turnId: "turn-1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 1.5 } });
    expect(stops.budget).toBeInstanceOf(BudgetExceeded);
    expect(recorded).toEqual([[(stops.budget as Error).message]]);
    expect(abortController.signal.aborted).toBe(true);
    // A stopped turn ignores later usage.
    expect(budget.observeUsage({ inputTokens: 1 } as never)).toBeUndefined();
  });

  test("a failed write makes accounting unavailable", async () => {
    const { run, stops, abortController, recorded } = budgetRun({ observe: () => Promise.reject(new Error("disk")), listPrice: () => null });
    createTurnBudget(run).observeUsage({ inputTokens: 1 } as never);
    await settleBudgetWrites(run);
    expect(stops.budget).toBeInstanceOf(BudgetUnavailable);
    expect(recorded).toEqual([[(stops.budget as Error).message, "budget_unavailable"]]);
    expect(abortController.signal.aborted).toBe(true);
  });
});

describe("slot setup", () => {
  test("a routing failure reports the error, settles queued work and releases the start's queue", () => {
    const { host, sent } = setupHost();
    const work = recordingWork();
    const initial: SlotInput = { authorization: AUTHORIZATION, text: "hi", attachments: [], requestId: "req-1", work };
    const starting = beginSlotStart(host, initial);
    const waiting = queued("waiting", AUTHORIZATION, { work: recordingWork() });
    starting.queue.push(waiting);
    reportRoutingFailure(host, initial, starting, new Error("no backend"), undefined);
    host.coordinator.endStarting(initial.sessionId, starting);
    expect(sent.filter(frame => frame.type === "error")).toEqual([expect.objectContaining({ code: "BACKEND_ERROR", message: "no backend", requestId: "req-1" })] as never);
    expect(work.settled).toEqual([["error", { reason: "no backend" }]]);
    expect((waiting.work as ReturnType<typeof recordingWork>).settled).toEqual([["error", { reason: "no backend" }]]);
    expect(waiting.released).toBe(1);
    expect(starting.queue).toEqual([]);
    expect(host.coordinator.startingSessions).toBe(0);
  });

  test("a revoked principal or a cancelled start registers no turn and releases the queue", async () => {
    const { host } = setupHost();
    const target = await resolveTurnTarget(host.registry, host.catalog, undefined, undefined);
    const revoked: SlotInput = { authorization: countedAuthorization(false), text: "hi", attachments: [] };
    const revokedStart = beginSlotStart(host, revoked);
    const waiting = queued("waiting");
    revokedStart.queue.push(waiting);
    host.coordinator.endStarting(undefined, revokedStart);
    expect(registerSessionSlot(host, revoked, revokedStart, target, "turn-1")).toBeUndefined();
    expect(waiting.released).toBe(1);
    const cancelled: SlotInput = { authorization: AUTHORIZATION, text: "hi", attachments: [] };
    const cancelledStart = beginSlotStart(host, cancelled);
    cancelledStart.cancelled = true;
    host.coordinator.endStarting(undefined, cancelledStart);
    expect(registerSessionSlot(host, cancelled, cancelledStart, target, "turn-1")).toBeUndefined();
    expect(host.coordinator.running.size).toBe(0);
  });

  test("an opened slot registers its turn and carries a new conversation's draft exchanges", async () => {
    const { host } = setupHost();
    const exchange = { id: "x-1" } as never;
    const slot = await openSlot(host, { draftId: "draft-1", localExchanges: [exchange] });
    expect(slot.turn).toMatchObject({ turnId: "turn-1", sessionId: null, draftId: "draft-1", providerId: "fake" });
    expect(slot.firstTurnId).toBe("turn-1");
    expect(slot.draftExchanges).toEqual([exchange]);
    expect(host.coordinator.running.has(slot.turn)).toBe(true);
    const resumed = await openSlot(host, { sessionId: "session-9", draftId: "ignored", localExchanges: [exchange] });
    expect(resumed.turn.draftId).toBeNull();
    expect(resumed.draftExchanges).toEqual([]);
  });

  test("the first request's lease settles its work as cancelled", () => {
    const work = recordingWork();
    const request = firstRequest({ authorization: AUTHORIZATION, text: "hi", attachments: [], requestId: "req-1", revision: 3, work });
    expect(request).toMatchObject({ text: "hi", requestId: "req-1", revision: 3, work });
    request.releaseAuthorization();
    expect(work.settled).toEqual([["cancelled", { reason: "The session ended before this request ran" }]]);
  });
});

describe("slot queue", () => {
  test("binding a revoked request releases its lease and keeps the slot's request fields", async () => {
    const { host } = setupHost();
    const slot = await openSlot(host);
    const entry = queued("later", countedAuthorization(false), { requestId: "req-2", revision: 4 });
    slot.releaseActive = entry.releaseAuthorization;
    expect(bindRequest(slot, entry, undefined)).toBe("revoked");
    expect(entry.released).toBe(1);
    expect(slot.releaseActive).toBeUndefined();
    expect(slot.turn.revision).toBeUndefined();
    expect(slot.turn.requestId).toBeUndefined();
    const valid = queued("now", AUTHORIZATION, { requestId: "req-3", revision: 5 });
    expect(bindRequest(slot, valid, undefined)).toBe("bound");
    expect(slot.turn).toMatchObject({ requestId: "req-3", revision: 5 });
  });

  test("dequeueing re-mints the turn and a dropped hand-over leaves the pending list", async () => {
    const { host } = setupHost();
    const slot = await openSlot(host, { sessionId: "session-1" });
    const changes: unknown[] = [];
    spyOn(host.coordinator, "queueChanged", ((sessionId: string | null, change: unknown) => { changes.push([sessionId, change]); }) as never);
    const entry = queued("next", AUTHORIZATION, { lifecycleTurnId: "turn-queued" });
    slot.turn.queue.push(entry);
    slot.turn.lastResult = "success";
    expect(dequeueRequest(slot.turn)).toBe(entry);
    expect(slot.turn).toMatchObject({ turnId: "turn-queued", lastResult: null, handingOver: entry });
    dropHandedOver(slot, queued("other"), REVOKED_REASON);
    expect(changes).toEqual([]);
    dropHandedOver(slot, entry, REVOKED_REASON);
    expect(changes).toEqual([["session-1", { dropped: { entries: [entry], reason: REVOKED_REASON } }]]);
    expect(dequeueRequest(slot.turn)).toBeNull();
    expect(slot.turn.handingOver).toBeUndefined();
  });

  test("closing the slot releases every lease once and unregisters its turn", async () => {
    const { host } = setupHost();
    const slot = await openSlot(host, { sessionId: "session-1" });
    const changes: unknown[] = [];
    spyOn(host.coordinator, "queueChanged", ((sessionId: string | null, change: unknown) => { changes.push([sessionId, change]); }) as never);
    const active = queued("active"), next = queued("next"), handed = queued("handed"), waiting = queued("waiting");
    slot.releaseActive = active.releaseAuthorization;
    slot.turn.handingOver = handed;
    slot.turn.queue.push(waiting);
    closeSessionSlot(slot, next);
    expect([active.released, next.released, handed.released, waiting.released]).toEqual([1, 1, 0, 1]);
    expect(changes).toEqual([["session-1", { dropped: { entries: [handed, waiting], reason: SLOT_ENDED_REASON } }]]);
    expect(host.coordinator.running.has(slot.turn)).toBe(false);
    expect(slot.turn.queue).toEqual([]);
  });

  test("releasing the active lease clears it", async () => {
    const { host } = setupHost();
    const slot = await openSlot(host);
    const active = queued("active");
    slot.releaseActive = active.releaseAuthorization;
    releaseActive(slot);
    expect(active.released).toBe(1);
    expect(slot.releaseActive).toBeUndefined();
  });
});

describe("host admission", () => {
  test("a voice turn on pi is denied before any runtime starts", async () => {
    const { host } = setupHost();
    const admission = await admitWorkerHost(host, makeFakeBackend({ id: "pi" }), recordingWork("voice"));
    expect(admission.kind).toBe("denied");
    expect((admission as { error: unknown }).error).toBeInstanceOf(BackendRequestError);
    expect((await admitWorkerHost(host, makeFakeBackend({ id: "pi" }), recordingWork())).kind).toBe("admitted");
  });

  test("the turn timeout aborts the turn and drains its pending requests", async () => {
    const { host } = setupHost(undefined, { turnTimeoutMs: 5 });
    const slot = await openSlot(host);
    const drained: string[] = [];
    spyOn(host.coordinator, "drainPendingForTurn", ((_turn: unknown, reason: string) => { drained.push(reason); }) as never);
    const controller = new AbortController();
    const handle = armTurnTimeout(host, slot.turn, controller);
    expect(slot.turn.timeoutHandle).toBe(handle);
    // The armed 5 ms timer aborts the turn, then drains it in the same
    // callback, before this continuation runs.
    await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
    expect(controller.signal.aborted).toBe(true);
    expect(drained).toEqual(["Turn timed out"]);
  });

  test("announcing a start dispatches the revision and moves the hand-over to started", async () => {
    const dispatched: unknown[] = [];
    const { host } = setupHost(undefined, { catalog: { ...catalog(), dispatchWork: (...args: unknown[]) => { dispatched.push(args); } } as SessionCatalog });
    const slot = await openSlot(host, { sessionId: "session-1" });
    const changes: unknown[] = [];
    spyOn(host.coordinator, "queueChanged", ((sessionId: string | null, change: unknown) => { changes.push([sessionId, change]); }) as never);
    const work = recordingWork();
    const entry = queued("next", AUTHORIZATION, { work });
    slot.turn.handingOver = entry;
    slot.turn.revision = 7;
    announceTurnStart(slot, entry, 1234);
    expect(slot.turn.startedAt).toBe(1234);
    expect(dispatched).toEqual([["session-1", 7, "turn-1", "fake", 1234]]);
    expect(changes).toEqual([["session-1", { started: { entry, turnId: "turn-1" } }]]);
    expect(slot.turn.handingOver).toBeUndefined();
    expect(work.startedWith).toEqual(["turn-1"]);
  });
});

describe("one slot turn", () => {
  test("a refused host check is returned to the slot before anything is reported", async () => {
    const { host, sent } = setupHost(makeFakeBackend({ id: "pi" }));
    const slot = await openSlot(host, { requestId: "req-1" });
    const work = recordingWork("voice");
    const entry = queued("hi", AUTHORIZATION, { work });
    slot.releaseActive = entry.releaseAuthorization;
    bindRequest(slot, entry, undefined);
    const result = await runSlotTurn(slot, entry, undefined);
    expect(result.kind).toBe("denied");
    expect((result as { error: unknown }).error).toBeInstanceOf(BackendRequestError);
    // The slot reports it, settles the work and releases the lease as it stops.
    expect(sent.some(frame => frame.type === "error")).toBe(false);
    expect(work.settled).toEqual([]);
    expect(entry.released).toBe(0);
  });

  test("a principal revoked during billing never reaches the backend", async () => {
    let started = 0;
    const { host } = setupHost(makeFakeBackend({ id: "fake", startTurn: async () => { started += 1; } }));
    const slot = await openSlot(host);
    const authorization = countedAuthorization(true);
    const entry = queued("hi", authorization, { revision: 2 });
    slot.releaseActive = entry.releaseAuthorization;
    bindRequest(slot, entry, undefined);
    spyOn(host, "expireAuthorizationContexts", (() => { (authorization as { valid: boolean }).valid = false; }) as never);
    expect(await runSlotTurn(slot, entry, undefined)).toEqual({ kind: "revoked" });
    expect(started).toBe(0);
    expect(slot.turn.revision).toBeUndefined();
    // The slot releases the lease in the same step as its next dequeue.
    expect(entry.released).toBe(0);
  });

  test("a principal revoked during governed admission is cancelled before start", async () => {
    let started = 0;
    const { host, sent } = setupHost(makeFakeBackend({ id: "fake", startTurn: async () => { started += 1; } }));
    const slot = await openSlot(host, { sessionId: "session-1" });
    const authorization = countedAuthorization(true);
    const work = recordingWork();
    const entry = queued("hi", authorization, { work });
    slot.releaseActive = entry.releaseAuthorization;
    bindRequest(slot, entry, undefined);
    let checks = 0;
    // Valid at the billing boundary, revoked by the time admission confirms.
    spyOn(host, "expireAuthorizationContexts", (() => { checks += 1; if (checks === 2) (authorization as { valid: boolean }).valid = false; }) as never);
    const result = await runSlotTurn(slot, entry, undefined);
    expect(result).toEqual({ kind: "ran", outcome: expect.objectContaining({ delivery: "cancelled_before_start", work: "cancelled", reason: REVOKED_REASON }) });
    expect(started).toBe(0);
    expect(sent.some(frame => frame.type === "error")).toBe(false);
    expect(work.settled).toEqual([["cancelled", { sessionId: "session-1", reason: REVOKED_REASON }]]);
    expect(entry.released).toBe(1);
  });

  test("a turn that ran settles its work and releases its lease, leaving the status to the slot", async () => {
    const requests: unknown[] = [];
    const { host, sent } = setupHost(makeFakeBackend({ id: "fake", startTurn: async (request) => { requests.push(request); } }));
    const slot = await openSlot(host, { sessionId: "session-1" });
    const work = recordingWork();
    const entry = queued("hi", AUTHORIZATION, { work, requestId: "req-1" });
    slot.releaseActive = entry.releaseAuthorization;
    bindRequest(slot, entry, undefined);
    const result = await runSlotTurn(slot, entry, undefined);
    expect(result).toEqual({ kind: "ran", outcome: expect.objectContaining({ lifecycle: "success", work: "completed", cancelledBeforeStart: false }) });
    expect(requests).toEqual([expect.objectContaining({ prompt: "hi", sessionId: "session-1", turnId: "turn-1", applicationAuthority: "server" })]);
    expect(work.settled).toEqual([["completed", { sessionId: "session-1" }]]);
    expect(entry.released).toBe(1);
    expect(slot.turn.retryRequest).toMatchObject({ type: "chat_message", text: "hi", requestId: "req-1" });
    expect(sent.some(frame => frame.type === "status" && frame.status === "idle")).toBe(false);
  });
});

describe("backend entry and status", () => {
  test("an ungoverned turn's request carries no sandbox, budget or worker hooks", () => {
    const { host } = setupHost();
    const controller = new AbortController();
    const bridge = {} as never;
    const request = turnRequest({
      host, turn: { turnId: "turn-1", sessionId: "session-1" }, current: { attachments: [], thinkingLevel: "high", work: recordingWork("voice") },
      abortController: controller, held: { referenceViews: null, referenceTurn: false, enteredBackend: false }, workerIdentity: undefined,
      turnId: "turn-1", profileId: "fake", resumeId: "session-1",
    } as unknown as TurnRun, "the prompt", bridge);
    expect(request).toEqual({
      applicationAuthority: "server", prompt: "the prompt", attachments: [], sessionId: "session-1", profileId: "fake",
      signal: controller.signal, turnBudgetMs: 5_000, bridge, turnId: "turn-1", thinkingLevel: "high",
      posture: "voice", enforceAllowedTools: true, noGrantSurface: true,
    } as never);
  });

  test("draft exchanges report whether each one was stored", async () => {
    const { host, sent } = setupHost(undefined, { catalog: { ...catalog(), recordLocalExchange: async (_sid: string, exchange: { id: string }) => exchange.id === "kept" } as SessionCatalog });
    recordDraftExchanges(host, "session-1", [{ id: "kept" }, { id: "lost" }] as never);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent.filter(frame => frame.type === "local_exchange_result")).toEqual([
      { type: "local_exchange_result", sessionId: "session-1", exchangeId: "kept", saved: true },
      { type: "local_exchange_result", sessionId: "session-1", exchangeId: "lost", saved: false, reason: "The server could not store it." },
    ] as never);
  });

  test("the slot status is cancelled before start, idle for a named session, and silent otherwise", () => {
    const { host, sent } = setupHost();
    publishTurnStatus({ host, turn: { turnId: "turn-1", sessionId: null, requestId: "req-1" } as never }, { cancelledBeforeStart: true });
    publishTurnStatus({ host, turn: { turnId: "turn-1", sessionId: "session-1" } as never }, { cancelledBeforeStart: false });
    publishTurnStatus({ host, turn: { turnId: "turn-1", sessionId: null } as never }, { cancelledBeforeStart: false });
    expect(sent).toEqual([
      expect.objectContaining({ type: "status", status: "cancelled", detail: "Cancelled before starting", requestId: "req-1" }),
      expect.objectContaining({ type: "status", status: "idle", sessionId: "session-1" }),
    ] as never);
  });
});
