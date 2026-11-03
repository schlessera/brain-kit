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
 * A backend that waits `askAfterMs`, asks, and ends its turn the way the
 * Claude turn runner does: an aborted turn emits `status: cancelled` and a
 * cancelled `result`; an answered one waits `answerHoldMs` and succeeds.
 */
function askingBackend(kind: Kind, timing: { askAfterMs: number; answerHoldMs?: number }) {
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
      await Bun.sleep(timing.askAfterMs);
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

async function started(kind: Kind, turnTimeoutMs: number, timing: { askAfterMs: number; answerHoldMs?: number }) {
  const fixture = askingBackend(kind, timing);
  setBackendForTests(fixture.backend);
  const host = testHost();
  // The configured value, as an operator sets it; nothing here changes it later.
  host.turnTimeoutMs = turnTimeoutMs;
  const c = fakeClient();
  await createWsHandlers(host, testPrincipal()).onOpen({} as Event, c.ws);
  await dispatch(host, c.ws, { type: "chat_message", text: "Ask me" }, asPrincipal("test-principal"));
  const requestType = kind === "ask_user" ? "ask_user_request" : `${kind}_request`;
  await waitFor(() => c.sent.some((f) => f.type === requestType));
  const request = c.sent.find((f) => f.type === requestType) as { turnId: string; sessionId: string };
  const send = async (msg: ClientMessage) => {
    const before = c.sent.length;
    await dispatch(host, c.ws, msg, asPrincipal("test-principal"));
    return c.sent.slice(before);
  };
  const terminal = () => c.sent.find((f) => f.type === "result") as Extract<ServerMessage, { type: "result" }> | undefined;
  return { ...fixture, host, c, request, send, terminal };
}

const receipts = (frames: ServerMessage[]) => frames.filter((f) => f.type === "ask_answer_receipt");
const cancelledStatuses = (frames: ServerMessage[]) =>
  frames.filter((f): f is Extract<ServerMessage, { type: "status" }> => f.type === "status" && f.status === "cancelled");

describe("a pending question when the host's turn limit runs out", () => {
  beforeEach(() => { resetForTests(); closeDb(); });
  afterEach(() => { resetForTests(); closeDb(); });

  for (const kind of KINDS) {
    describe(kind, () => {
      test("expires at the original elapsed deadline, counting the wait, and says the host's limit ended it", async () => {
        // The question arrives two thirds of the way in. A limit restarted
        // by the question would end the turn no sooner than 300 ms after it.
        const TIMEOUT = 300;
        const { host, c, request, send, failures, settlements, clock, terminal } = await started(kind, TIMEOUT, { askAfterMs: 200 });
        await waitFor(() => terminal() !== undefined);
        const elapsed = clock.abortedAt! - clock.startedAt!;
        expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 5);
        expect(elapsed).toBeLessThan(clock.askedAt! - clock.startedAt! + TIMEOUT);

        // The pending question was drained, not answered.
        await waitFor(() => failures.length === 1);
        expect(failures[0]!.message).toContain("Turn timed out");
        expect(settlements).toEqual([]);
        expect(host.coordinator.pendingAskUser.size + host.coordinator.pendingAskUserList.size
          + host.coordinator.pendingAskUserRank.size + host.coordinator.pendingAskUserForm.size).toBe(0);

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
    });
  }

  test("a cancel someone asked for is not reported as a timeout", async () => {
    const { host, c, failures, terminal } = await started("ask_user", 5_000, { askAfterMs: 0 });
    host.coordinator.cancelTurn(host.coordinator.bySession.get("s1")!, "Cancelled by user");
    await waitFor(() => failures.length === 1 && terminal() !== undefined);
    expect(terminal()!.outcome).toBe("cancelled");
    expect(terminal()!.outcomeDetail).toBeUndefined();
    expect(cancelledStatuses(c.sent).map((f) => f.detail)).toEqual([undefined]);
  });

  test("a timely answer is receipt-confirmed and the turn completes without a timeout", async () => {
    const { request, send, settlements, terminal } = await started("ask_user_list", 5_000, { askAfterMs: 0 });
    const frames = await send(answerFrame("ask_user_list", { submissionId: "sub-a", turnId: request.turnId, sessionId: "s1" }));
    expect(receipts(frames)[0]).toMatchObject({ state: "accepted", submissionId: "sub-a" });
    await waitFor(() => terminal() !== undefined);
    expect(settlements).toHaveLength(1);
    expect(terminal()).toMatchObject({ outcome: "success" });
    expect(terminal()!.outcomeDetail).toBeUndefined();
  });

  test("an answer that wins the race stays accepted when the limit then ends the turn", async () => {
    const { host, request, send, settlements, failures, terminal } = await started("ask_user_rank", 250, { askAfterMs: 0, answerHoldMs: 5_000 });
    const frames = await send(answerFrame("ask_user_rank", { submissionId: "sub-a", turnId: request.turnId, sessionId: "s1" }));
    expect(receipts(frames)[0]).toMatchObject({ state: "accepted" });
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
