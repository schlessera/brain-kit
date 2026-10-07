/**
 * Ask answers with delivery receipts (rev 5, #910), through the real host,
 * connection and dispatch, for all four ask kinds.
 *
 * What used to happen: an answer for a request the host did not know was
 * dropped without a frame, and nothing told the client whether its answer had
 * settled anything. These assert the receipt the sender gets in every case,
 * that a repeated submission settles the request at most once, and that an
 * answer from a client that cannot read receipts is refused without settling.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ASK_ANSWER_UPDATE_REQUIRED,
  type AskUserFormSpec,
  type AskUserListSpec,
  type AskUserQuestion,
  type AskUserRankSpec,
  type ClientMessage,
  type ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, BackendBridge, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers } from "../src/ws/connection";
import { handleClientMessage as dispatch } from "../src/ws/dispatch";
import type { WSContext } from "../src/ws/clients";
import { closeDb, resetForTests, setBackendForTests, testHost } from "./helpers/test-host";
import { testAuthorization, testPrincipal } from "./helpers/principal";

type Kind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
const KINDS: Kind[] = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"];

const QUESTIONS: AskUserQuestion[] = [
  {
    question: "Which harbour first?",
    header: "Harbour",
    multiSelect: false,
    options: [
      { label: "Ithaca", description: "Home" },
      { label: "Pylos", description: "Nestor’s court" },
    ],
  },
];
const LIST: AskUserListSpec = {
  prompt: "Which stores are aboard?",
  scale: [{ label: "Aboard" }, { label: "Missing" }],
  items: [
    { id: "oars", label: "Spare oars" },
    { id: "wine", label: "Wine from Maron" },
  ],
  allowSkip: true,
  notes: true,
};
const RANK: AskUserRankSpec = {
  prompt: "Rank the landings",
  items: [
    { id: "aeolia", label: "Aeolia" },
    { id: "scheria", label: "Scheria" },
  ],
};
const FORM: AskUserFormSpec = {
  prompt: "Plan the crossing",
  nodes: [{ id: "course", kind: "single", prompt: "Which course?", options: [{ label: "Coast" }, { label: "Open sea" }] }],
};

/** One nonempty (and multibyte) answer per kind, as the four frames carry it. */
function answerFrame(kind: Kind, extra: Record<string, unknown>): ClientMessage {
  const base = { requestId: "req-1", ...extra };
  switch (kind) {
    case "ask_user":
      return { type: "ask_user_response", ...base, answers: { "Which harbour first?": "Ithaca — Ὀθάκη" } } as ClientMessage;
    case "ask_user_list":
      return { type: "ask_user_list_response", ...base, answers: { oars: "Aboard" }, notes: { wine: "Maron’s gift \u{1F377}" } } as ClientMessage;
    case "ask_user_rank":
      return { type: "ask_user_rank_response", ...base, order: ["scheria", "aeolia"], unchanged: false } as ClientMessage;
    case "ask_user_form":
      return { type: "ask_user_form_response", ...base, answers: { course: { value: "Coast" } } } as ClientMessage;
  }
}

function ask(bridge: BackendBridge, kind: Kind): Promise<unknown> {
  switch (kind) {
    case "ask_user":
      return bridge.askUser!("req-1", QUESTIONS);
    case "ask_user_list":
      return bridge.askUserList!("req-1", LIST);
    case "ask_user_rank":
      return bridge.askUserRank!("req-1", RANK);
    case "ask_user_form":
      return bridge.askUserForm!("req-1", FORM);
  }
}

/** A backend whose turn asks one question and records every settlement. */
function askingBackend(kind: Kind, history: SessionHistoryMessage[] = []) {
  const settlements: unknown[] = [];
  const failures: Error[] = [];
  const backend: AgentBackend = {
    id: "fake",
    capabilities: {
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: true,
      costReporting: true,
      concurrentSessions: true,
      followUp: false,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn({ bridge }) {
      bridge.emit({ type: "session_info", sessionId: "s1", isNew: true, providerId: "default" });
      try {
        settlements.push(await ask(bridge, kind));
      } catch (error) {
        failures.push(error as Error);
      }
    },
    async listSessions() {
      return [];
    },
    async getHistory() {
      return history;
    },
  };
  return { backend, settlements, failures };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send: (data: string) => sent.push(JSON.parse(data) as ServerMessage) };
  return { ws, sent };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

const asPrincipal = (id: string) => ({ principal: testPrincipal(id), authorization: testAuthorization(id) });

async function started(kind: Kind, history: SessionHistoryMessage[] = []) {
  const { backend, settlements, failures } = askingBackend(kind, history);
  setBackendForTests(backend);
  const host = testHost();
  const c = fakeClient();
  await createWsHandlers(host, testPrincipal()).onOpen({} as Event, c.ws);
  await dispatch(host, c.ws, { type: "chat_message", text: "Ask me" }, asPrincipal("test-principal"));
  const requestType = kind === "ask_user" ? "ask_user_request" : `${kind}_request`;
  await waitFor(() => c.sent.some((f) => f.type === requestType));
  const request = c.sent.find((f) => f.type === requestType) as { turnId: string; sessionId: string };
  const send = async (msg: ClientMessage, principalId = "test-principal", client = c) => {
    const before = client.sent.length;
    await dispatch(host, client.ws, msg, asPrincipal(principalId));
    return client.sent.slice(before);
  };
  return { host, c, request, send, settlements, failures };
}

const receipts = (frames: ServerMessage[]) => frames.filter((f) => f.type === "ask_answer_receipt");

describe("ask answer receipts", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      test("an answer settles once; the same submission repeated gets the same receipt", async () => {
        const { request, send, settlements } = await started(kind);
        const answer = answerFrame(kind, { submissionId: "sub-a", turnId: request.turnId, sessionId: "s1" });
        const first = await send(answer);
        expect(receipts(first)).toEqual([
          { type: "ask_answer_receipt", requestId: "req-1", submissionId: "sub-a", state: "accepted", sessionId: "s1", turnId: request.turnId },
        ]);
        await waitFor(() => settlements.length === 1);
        // The answer that settled is the one that was sent, nonempty.
        const expected = {
          ask_user: { answers: { "Which harbour first?": "Ithaca — Ὀθάκη" }, annotations: undefined },
          ask_user_list: { answers: { oars: "Aboard" }, notes: { wine: "Maron’s gift \u{1F377}" } },
          ask_user_rank: { order: ["scheria", "aeolia"], unchanged: false },
          ask_user_form: { answers: { course: { value: "Coast" } } },
        };
        expect(settlements[0]).toEqual(expected[kind]);

        const again = await send(answer);
        expect(receipts(again)).toEqual([
          { type: "ask_answer_receipt", requestId: "req-1", submissionId: "sub-a", state: "accepted", sessionId: "s1", turnId: request.turnId },
        ]);
        const other = await send(answerFrame(kind, { submissionId: "sub-b", turnId: request.turnId }));
        expect(receipts(other)[0]).toMatchObject({ submissionId: "sub-b", state: "closed", reason: "answered_elsewhere" });
        await Bun.sleep(10);
        expect(settlements).toHaveLength(1);
      });

      test("an answer without a submission id is refused as update-required and settles nothing", async () => {
        const { host, request, send, settlements } = await started(kind);
        const frames = await send(answerFrame(kind, { turnId: request.turnId }));
        expect(frames).toEqual([
          expect.objectContaining({ type: "error", code: ASK_ANSWER_UPDATE_REQUIRED, requestId: "req-1" }),
        ]);
        expect(receipts(frames)).toEqual([]);
        await Bun.sleep(10);
        expect(settlements).toEqual([]);
        // Still waiting, and an updated client can still answer it.
        const ok = await send(answerFrame(kind, { submissionId: "sub-a", turnId: request.turnId }));
        expect(receipts(ok)[0]).toMatchObject({ state: "accepted" });
        await waitFor(() => settlements.length === 1);
        expect(host.coordinator.askOutcome("req-1")).toMatchObject({ state: "accepted", submissionId: "sub-a" });
      });

      test("a stale turn or another session is refused and leaves the request waiting", async () => {
        const { host, request, send, settlements } = await started(kind);
        const stale = await send(answerFrame(kind, { submissionId: "sub-a", turnId: "turn-from-before" }));
        expect(receipts(stale)[0]).toMatchObject({ state: "closed", reason: "refused" });
        const missing = await send(answerFrame(kind, { submissionId: "sub-b" }));
        expect(receipts(missing)[0]).toMatchObject({ state: "closed", reason: "refused" });
        const elsewhere = await send(answerFrame(kind, { submissionId: "sub-c", turnId: request.turnId, sessionId: "s-other" }));
        expect(receipts(elsewhere)[0]).toMatchObject({ state: "closed", reason: "refused" });
        await Bun.sleep(10);
        expect(settlements).toEqual([]);
        const status = await send({ type: "ask_answer_status", requestId: "req-1", submissionId: "sub-d" });
        expect(receipts(status)[0]).toMatchObject({ state: "pending", turnId: request.turnId, sessionId: "s1" });
        expect(host.coordinator.askOutcome("req-1")).toBeUndefined();
      });

      test("status reports pending, then accepted, and is bound to the principal", async () => {
        const { request, send } = await started(kind);
        const before = await send({ type: "ask_answer_status", requestId: "req-1", submissionId: "sub-a", sessionId: "s1" });
        expect(receipts(before)[0]).toMatchObject({ state: "pending", turnId: request.turnId });
        await send(answerFrame(kind, { submissionId: "sub-a", turnId: request.turnId }));
        const after = await send({ type: "ask_answer_status", requestId: "req-1", submissionId: "sub-a" });
        expect(receipts(after)[0]).toMatchObject({ state: "accepted" });
        const stranger = await send({ type: "ask_answer_status", requestId: "req-1", submissionId: "sub-a" }, "another-principal");
        expect(receipts(stranger)[0]).toMatchObject({ state: "closed", reason: "not_recognized" });
      });

      test("a dismissed question answers closed: cancelled", async () => {
        const { request, send, failures } = await started(kind);
        await send({ type: "ask_user_cancel", requestId: "req-1", turnId: request.turnId });
        await waitFor(() => failures.length === 1);
        const late = await send(answerFrame(kind, { submissionId: "sub-a", turnId: request.turnId }));
        expect(receipts(late)[0]).toMatchObject({ state: "closed", reason: "cancelled" });
      });

      test("a question whose turn ended answers closed: ended", async () => {
        const { host, request, send, failures } = await started(kind);
        const turn = host.coordinator.bySession.get("s1")!;
        host.coordinator.cancelTurn(turn, "Cancelled by user");
        await waitFor(() => failures.length === 1);
        const late = await send(answerFrame(kind, { submissionId: "sub-a", turnId: request.turnId }));
        expect(receipts(late)[0]).toMatchObject({ state: "closed", reason: "ended", turnId: request.turnId });
      });

      test("a resumed session gets its pending question again, after the history", async () => {
        const history: SessionHistoryMessage[] = [{ role: "user", content: "Ask me", toolCalls: [] }];
        const { host, request } = await started(kind, history);
        const c2 = fakeClient();
        await dispatch(host, c2.ws, { type: "session_resume", sessionId: "s1" }, asPrincipal("test-principal"));
        const types: string[] = c2.sent.map((f) => f.type);
        const requestType = kind === "ask_user" ? "ask_user_request" : `${kind}_request`;
        expect(types).toContain("session_history");
        expect(types.indexOf(requestType)).toBeGreaterThan(types.indexOf("session_history"));
        expect(c2.sent.find((f) => f.type === requestType)).toMatchObject({ requestId: "req-1", turnId: request.turnId, sessionId: "s1" });
        // A different session's resume does not carry this question.
        const c3 = fakeClient();
        await dispatch(host, c3.ws, { type: "session_resume", sessionId: "s-other" }, asPrincipal("test-principal"));
        expect(c3.sent.some((f) => f.type === requestType)).toBe(false);
      });
    });
  }

  test("an answer for a request the host never knew is closed: not_recognized", async () => {
    const { send } = await started("ask_user");
    const frames = await send({
      type: "ask_user_response",
      requestId: "never-asked",
      submissionId: "sub-z",
      turnId: "t",
      answers: { q: "a" },
    });
    expect(receipts(frames)).toEqual([
      { type: "ask_answer_receipt", requestId: "never-asked", submissionId: "sub-z", state: "closed", reason: "not_recognized" },
    ]);
  });

  test("an answer shaped for another kind is refused", async () => {
    const { request, send, settlements } = await started("ask_user_rank");
    const frames = await send(answerFrame("ask_user_list", { submissionId: "sub-a", turnId: request.turnId }));
    expect(receipts(frames)[0]).toMatchObject({ state: "closed", reason: "refused" });
    await Bun.sleep(10);
    expect(settlements).toEqual([]);
  });

  test("the receipt goes to the sender only", async () => {
    const { host, request, send } = await started("ask_user");
    const watcher = fakeClient();
    host.clients.add(watcher.ws, "test-principal");
    await send(answerFrame("ask_user", { submissionId: "sub-a", turnId: request.turnId }));
    expect(receipts(watcher.sent)).toEqual([]);
  });
});

describe("hello and liveness", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("server_hello advertises receipts and liveness, with a per-principal key", async () => {
    setBackendForTests(askingBackend("ask_user").backend);
    const host = testHost();
    const hello = async (id: string) => {
      const c = fakeClient();
      await createWsHandlers(host, testPrincipal(id)).onOpen({} as Event, c.ws);
      return c.sent.find((f) => f.type === "server_hello") as Extract<ServerMessage, { type: "server_hello" }>;
    };
    const a = await hello("principal-a");
    const a2 = await hello("principal-a");
    const b = await hello("principal-b");
    expect(a.protocolRev).toBe(5);
    expect(a.capabilities).toMatchObject({ askReceipts: true, liveness: true });
    expect(a.principalKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a2.principalKey).toBe(a.principalKey);
    expect(b.principalKey).not.toBe(a.principalKey);
    expect(a.principalKey).not.toContain("principal-a");
  });

  test("ping is answered with pong to the same socket", async () => {
    setBackendForTests(askingBackend("ask_user").backend);
    const host = testHost();
    const c = fakeClient();
    await dispatch(host, c.ws, { type: "ping", probeId: "probe-1" }, asPrincipal("test-principal"));
    expect(c.sent).toEqual([{ type: "pong", probeId: "probe-1" }]);
  });
});
