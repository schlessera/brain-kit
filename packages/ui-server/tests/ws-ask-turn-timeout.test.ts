/**
 * A pending question when the host's hard turn limit runs out (#3356),
 * through the real host, coordinator, bridge and dispatch, for all four ask
 * kinds.
 *
 * The limit stays a hard elapsed-time limit that counts the wait for the
 * user: a question neither pauses nor restarts it. When it runs out, the
 * question is drained, a late answer is closed rather than accepted, and the
 * turn's cancelled terminal frames say the host's limit ended it, so the
 * conversation can show a timeout rather than an unexplained stop. A cancel
 * someone asked for never says so, and an answer that won the race stays the
 * accepted one.
 *
 * The limit is the host's real registered timer, held on a test clock
 * (docs/process/test-waits.md, "Production timer"). It is armed several
 * awaits before the backend's startTurn, so on a loaded runner a real 300 ms
 * limit could run out before a question asked 200 ms into startTurn, and the
 * case then tested a question raised after its turn's drain (#3553). Both
 * orders are now cases of their own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HOST_TIMEOUT_OUTCOME_DETAIL,
  type AskUserFormSpec,
  type AskUserListSpec,
  type AskUserQuestion,
  type AskUserRankSpec,
  type ClientMessage,
  type ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers } from "../src/ws/connection";
import { handleClientMessage as dispatch } from "../src/ws/dispatch";
import type { WSContext } from "../src/ws/clients";
import { closeDb, resetForTests, setBackendForTests, testHost } from "./helpers/test-host";
import { testAuthorization, testPrincipal } from "./helpers/principal";

type Kind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
const KINDS: Kind[] = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"];

const QUESTIONS: AskUserQuestion[] = [{
  question: "Which harbour first?", header: "Harbour", multiSelect: false,
  options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor’s court" }],
}];
const LIST: AskUserListSpec = {
  prompt: "Which stores are aboard?", scale: [{ label: "Aboard" }, { label: "Missing" }],
  items: [{ id: "oars", label: "Spare oars" }, { id: "wine", label: "Wine from Maron" }], allowSkip: true, notes: true,
};
const RANK: AskUserRankSpec = { prompt: "Rank the landings", items: [{ id: "aeolia", label: "Aeolia" }, { id: "scheria", label: "Scheria" }] };
const FORM: AskUserFormSpec = {
  prompt: "Plan the crossing",
  nodes: [{ id: "course", kind: "single", prompt: "Which course?", options: [{ label: "Coast" }, { label: "Open sea" }] }],
};

function answerFrame(kind: Kind, extra: Record<string, unknown>): ClientMessage {
  const base = { requestId: "req-1", ...extra };
  switch (kind) {
    case "ask_user": return { type: "ask_user_response", ...base, answers: { "Which harbour first?": "Ithaca" } } as ClientMessage;
    case "ask_user_list": return { type: "ask_user_list_response", ...base, answers: { oars: "Aboard" } } as ClientMessage;
    case "ask_user_rank": return { type: "ask_user_rank_response", ...base, order: ["scheria", "aeolia"], unchanged: false } as ClientMessage;
    case "ask_user_form": return { type: "ask_user_form_response", ...base, answers: { course: { value: "Coast" } } } as ClientMessage;
  }
}

function ask(bridge: BackendBridge, kind: Kind): Promise<unknown> {
  switch (kind) {
    case "ask_user": return bridge.askUser!("req-1", QUESTIONS);
    case "ask_user_list": return bridge.askUserList!("req-1", LIST);
    case "ask_user_rank": return bridge.askUserRank!("req-1", RANK);
    case "ask_user_form": return bridge.askUserForm!("req-1", FORM);
  }
}

/**
 * The host's turn-limit timer, held on a logical clock. Every `setTimeout`
 * registered with the limit's delay is held; every other timer runs natively.
 * `advanceTo` runs held callbacks that are due, in registration order.
 */
function turnLimitClock(limitMs: number) {
  const descriptors = (["setTimeout", "clearTimeout"] as const).map(name => Object.getOwnPropertyDescriptor(globalThis, name)!);
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  type Held = { delay: number; due: number; fn: () => void; cleared: boolean; fired: boolean };
  const registrations: Held[] = [];
  let now = 0;
  const held = new Set<Held>();
  Object.defineProperty(globalThis, "setTimeout", { ...descriptors[0], value: ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== limitMs) return nativeSet(fn, delay, ...args);
    const timer: Held = { delay, due: now + delay, fn: () => fn(...args), cleared: false, fired: false };
    registrations.push(timer); held.add(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout });
  Object.defineProperty(globalThis, "clearTimeout", { ...descriptors[1], value: ((handle: unknown) => {
    if (held.has(handle as Held)) { (handle as Held).cleared = true; held.delete(handle as Held); return; }
    nativeClear(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout });
  return {
    registrations,
    get now() { return now; },
    advanceTo(ms: number) {
      now = ms;
      for (const timer of registrations) {
        if (!held.has(timer) || timer.due > now) continue;
        held.delete(timer); timer.fired = true; timer.fn();
      }
    },
    restore() {
      Object.defineProperty(globalThis, "setTimeout", descriptors[0]);
      Object.defineProperty(globalThis, "clearTimeout", descriptors[1]);
    },
    descriptors,
  };
}

/** A gate the test opens: the backend asks once it opens. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

/**
 * A backend that waits `askAfterMs` (or its `askWhen` gate), asks, and ends its turn the way the
 * Claude turn runner does: an aborted turn emits `status: cancelled` and a
 * cancelled `result`; an answered one waits `answerHoldMs` and succeeds.
 */
type Timing = { askAfterMs?: number; askWhen?: Promise<void>; answerHoldMs?: number };

function askingBackend(kind: Kind, timing: Timing) {
  const settlements: unknown[] = [];
  const failures: Error[] = [];
  const clock: { startedAt?: number; askedAt?: number; abortedAt?: number } = {};
  const backend: AgentBackend = {
    id: "fake",
    capabilities: {
      resume: true, permissions: true, thinking: true, attachments: true, askUser: true,
      costReporting: true, concurrentSessions: true, followUp: false,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn({ bridge, signal }) {
      clock.startedAt = performance.now();
      signal.addEventListener("abort", () => { clock.abortedAt = performance.now(); }, { once: true });
      bridge.emit({ type: "session_info", sessionId: "s1", isNew: true, providerId: "default" });
      await (timing.askWhen ?? Bun.sleep(timing.askAfterMs ?? 0));
      clock.askedAt = performance.now();
      try {
        settlements.push(await ask(bridge, kind));
        if (timing.answerHoldMs) await new Promise((resolve) => {
          const timer = setTimeout(resolve, timing.answerHoldMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
        });
      } catch (error) {
        failures.push(error as Error);
      }
      if (signal.aborted) {
        bridge.emit({ type: "status", status: "cancelled" });
        bridge.emit({ type: "result", sessionId: "s1", outcome: "cancelled", durationMs: 1, numTurns: 1, isError: false });
      } else {
        bridge.emit({ type: "result", sessionId: "s1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      }
    },
    async listSessions() { return []; },
    async getHistory() { return []; },
  };
  return { backend, settlements, failures, clock };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send: (data: string) => sent.push(JSON.parse(data) as ServerMessage) };
  return { ws, sent };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

const asPrincipal = (id: string) => ({ principal: testPrincipal(id), authorization: testAuthorization(id) });

async function dispatched(kind: Kind, turnTimeoutMs: number, timing: Timing) {
  const fixture = askingBackend(kind, timing);
  setBackendForTests(fixture.backend);
  const host = testHost();
  // The configured value, as an operator sets it; nothing here changes it later.
  host.turnTimeoutMs = turnTimeoutMs;
  const c = fakeClient();
  await createWsHandlers(host, testPrincipal()).onOpen({} as Event, c.ws);
  await dispatch(host, c.ws, { type: "chat_message", text: "Ask me" }, asPrincipal("test-principal"));
  const send = async (msg: ClientMessage) => {
    const before = c.sent.length;
    await dispatch(host, c.ws, msg, asPrincipal("test-principal"));
    return c.sent.slice(before);
  };
  const terminal = () => c.sent.find((f) => f.type === "result") as Extract<ServerMessage, { type: "result" }> | undefined;
  return { ...fixture, host, c, send, terminal };
}

const requestTypeOf = (kind: Kind) => kind === "ask_user" ? "ask_user_request" : `${kind}_request`;

async function started(kind: Kind, turnTimeoutMs: number, timing: Timing) {
  const fixture = await dispatched(kind, turnTimeoutMs, timing);
  await waitFor(() => fixture.c.sent.some((f) => f.type === requestTypeOf(kind)));
  const request = fixture.c.sent.find((f) => f.type === requestTypeOf(kind)) as { turnId: string; sessionId: string };
  return { ...fixture, request };
}

const receipts = (frames: ServerMessage[]) => frames.filter((f) => f.type === "ask_answer_receipt");
const cancelledStatuses = (frames: ServerMessage[]) =>
  frames.filter((f): f is Extract<ServerMessage, { type: "status" }> => f.type === "status" && f.status === "cancelled");

const pendingAsks = (host: Awaited<ReturnType<typeof dispatched>>["host"]) => host.coordinator.pendingAskUser.size
  + host.coordinator.pendingAskUserList.size + host.coordinator.pendingAskUserRank.size + host.coordinator.pendingAskUserForm.size;

describe("a pending question when the host's turn limit runs out", () => {
  let clock: ReturnType<typeof turnLimitClock> | undefined;
  beforeEach(() => { resetForTests(); closeDb(); });
  afterEach(() => {
    clock?.restore();
    if (clock) expect(["setTimeout", "clearTimeout"].map(name => Object.getOwnPropertyDescriptor(globalThis, name)), "TURN_LIMIT_TIMER_DESCRIPTORS_RESTORED").toEqual(clock.descriptors);
    clock = undefined;
    resetForTests(); closeDb();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      test("expires at the original elapsed deadline, counting the wait, and says the host's limit ended it", async () => {
        // The question arrives two thirds of the way in. A limit restarted
        // by the question would end the turn no sooner than 300 ms after it.
        const TIMEOUT = 300;
        clock = turnLimitClock(TIMEOUT);
        const asks = gate();
        const f = await dispatched(kind, TIMEOUT, { askWhen: asks.opened });
        const { host, c, send, failures, settlements, terminal } = f;
        // The limit is armed once, at the configured value, before the backend runs.
        await waitFor(() => f.clock.startedAt !== undefined);
        expect(clock.registrations.map(timer => timer.delay), "TURN_LIMIT_ARMED_ONCE_AT_CONFIGURED_VALUE").toEqual([TIMEOUT]);
        clock.advanceTo(200);
        asks.open();
        await waitFor(() => c.sent.some((frame) => frame.type === requestTypeOf(kind)));
        const request = c.sent.find((frame) => frame.type === requestTypeOf(kind)) as { turnId: string };
        // The question neither pauses nor restarts the limit.
        expect(clock.registrations.map(({ delay, due, cleared, fired }) => ({ delay, due, cleared, fired })), "TURN_LIMIT_NOT_RESTARTED_BY_QUESTION")
          .toEqual([{ delay: TIMEOUT, due: TIMEOUT, cleared: false, fired: false }]);
        clock.advanceTo(TIMEOUT - 1);
        expect(clock.registrations[0]!.fired, "TURN_LIMIT_NOT_EARLY").toBe(false);
        expect(pendingAsks(host)).toBe(1);
        expect(terminal()).toBeUndefined();
        // The original deadline, 100 ms after the question, ends it.
        clock.advanceTo(TIMEOUT);
        expect(clock.registrations[0]!.fired, "TURN_LIMIT_FIRES_AT_ORIGINAL_DEADLINE").toBe(true);
        await waitFor(() => terminal() !== undefined);

        // The pending question was drained, not answered.
        await waitFor(() => failures.length === 1);
        expect(failures[0]!.message).toContain("Turn timed out");
        expect(settlements).toEqual([]);
        expect(pendingAsks(host)).toBe(0);

        // The terminal says so: still cancelled, never a success.
        expect(cancelledStatuses(c.sent)).toEqual([expect.objectContaining({ detail: "Turn timed out", turnId: request.turnId })]);
        expect(terminal()).toMatchObject({ outcome: "cancelled", outcomeDetail: HOST_TIMEOUT_OUTCOME_DETAIL, isError: false, turnId: request.turnId });
        await waitFor(() => host.coordinator.running.size === 0);

        // A late answer to the ended question is closed, never accepted.
        const late = await send(answerFrame(kind, { submissionId: "sub-late", turnId: request.turnId, sessionId: "s1" }));
        expect(receipts(late)[0]).toMatchObject({ state: "closed", reason: "ended" });
        expect(host.coordinator.askOutcome("req-1")?.state).not.toBe("accepted");
        expect(settlements).toEqual([]);
      });

      test("a question raised after the limit ran out is refused at once, and the turn still ends with the host's limit", async () => {
        // The order a loaded runner produced (#3553): the limit is armed before
        // startTurn and runs out before the backend reaches its question.
        const TIMEOUT = 300;
        clock = turnLimitClock(TIMEOUT);
        const asks = gate();
        const f = await dispatched(kind, TIMEOUT, { askWhen: asks.opened });
        const { host, c, send, failures, settlements, terminal } = f;
        await waitFor(() => f.clock.startedAt !== undefined);
        clock.advanceTo(TIMEOUT);
        expect(clock.registrations.map(timer => timer.fired), "TURN_LIMIT_RAN_OUT_BEFORE_QUESTION").toEqual([true]);
        asks.open();
        await waitFor(() => terminal() !== undefined);
        expect(f.clock.abortedAt! <= f.clock.askedAt!).toBe(true);

        // Refused with the drain's reason, never shown, never left pending.
        expect(failures.map(error => error.message)).toEqual(["Turn timed out"]);
        expect(settlements).toEqual([]);
        expect(c.sent.some((frame) => frame.type === requestTypeOf(kind)), "LATE_QUESTION_NOT_SHOWN").toBe(false);
        expect(pendingAsks(host)).toBe(0);
        expect(host.coordinator.askOutcome("req-1")).toMatchObject({ state: "closed", reason: "ended" });
        expect(terminal()).toMatchObject({ outcome: "cancelled", outcomeDetail: HOST_TIMEOUT_OUTCOME_DETAIL, isError: false });
        await waitFor(() => host.coordinator.running.size === 0);

        // Turn scope stamps the id on every frame; the result type does not declare it.
        const turnId = (terminal() as { turnId?: string }).turnId;
        expect(turnId).toBeString();
        const late = await send(answerFrame(kind, { submissionId: "sub-late", turnId, sessionId: "s1" }));
        expect(receipts(late)[0]).toMatchObject({ state: "closed", reason: "ended" });
        expect(settlements).toEqual([]);
      });
    });
  }

  // The remaining cases hold their limit too: none of them may depend on the
  // backend reaching its question before a real limit runs out.
  test("a cancel someone asked for is not reported as a timeout", async () => {
    clock = turnLimitClock(5_000);
    const { host, c, failures, terminal } = await started("ask_user", 5_000, { askAfterMs: 0 });
    host.coordinator.cancelTurn(host.coordinator.bySession.get("s1")!, "Cancelled by user");
    await waitFor(() => failures.length === 1 && terminal() !== undefined);
    expect(terminal()!.outcome).toBe("cancelled");
    expect(terminal()!.outcomeDetail).toBeUndefined();
    expect(cancelledStatuses(c.sent).map((f) => f.detail)).toEqual([undefined]);
  });

  test("a timely answer is receipt-confirmed and the turn completes without a timeout", async () => {
    clock = turnLimitClock(5_000);
    const { request, send, settlements, terminal } = await started("ask_user_list", 5_000, { askAfterMs: 0 });
    const frames = await send(answerFrame("ask_user_list", { submissionId: "sub-a", turnId: request.turnId, sessionId: "s1" }));
    expect(receipts(frames)[0]).toMatchObject({ state: "accepted", submissionId: "sub-a" });
    await waitFor(() => terminal() !== undefined);
    expect(settlements).toHaveLength(1);
    expect(terminal()).toMatchObject({ outcome: "success" });
    expect(terminal()!.outcomeDetail).toBeUndefined();
  });

  test("an answer that wins the race stays accepted when the limit then ends the turn", async () => {
    clock = turnLimitClock(250);
    const { host, request, send, settlements, failures, terminal } = await started("ask_user_rank", 250, { askAfterMs: 0, answerHoldMs: 5_000 });
    const frames = await send(answerFrame("ask_user_rank", { submissionId: "sub-a", turnId: request.turnId, sessionId: "s1" }));
    expect(receipts(frames)[0]).toMatchObject({ state: "accepted" });
    clock.advanceTo(250);
    expect(clock.registrations.map(timer => timer.fired), "RACE_LIMIT_FIRES_AFTER_ACCEPTED_ANSWER").toEqual([true]);
    await waitFor(() => terminal() !== undefined);
    expect(terminal()).toMatchObject({ outcome: "cancelled", outcomeDetail: HOST_TIMEOUT_OUTCOME_DETAIL });
    // Only the winning outcome settled: the answer, once, and no drain of it.
    expect(settlements).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(host.coordinator.askOutcome("req-1")).toMatchObject({ state: "accepted", submissionId: "sub-a" });
    const repeat = await send(answerFrame("ask_user_rank", { submissionId: "sub-a", turnId: request.turnId, sessionId: "s1" }));
    expect(receipts(repeat)[0]).toMatchObject({ state: "accepted", submissionId: "sub-a" });
  });
});
