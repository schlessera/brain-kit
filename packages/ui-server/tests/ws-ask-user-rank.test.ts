/**
 * `ask_user_rank` over the socket (#584): the request goes out as one frame,
 * the answer comes back as every item id in order, a dismissal rejects through the same
 * `ask_user_cancel` frame `ask_user` uses, and a pending card survives a
 * disconnect and re-delivers on reconnect, as an `ask_user` card does.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AskUserRankSpec, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, AskUserRankResult } from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers as createAuthorizedWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import {
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
  testHost,
} from "./helpers/test-host";
import { testPrincipal } from "./helpers/principal";

const createWsHandlers = (host: ReturnType<typeof testHost>) =>
  createAuthorizedWsHandlers(host, testPrincipal());

const SPEC: AskUserRankSpec = {
  prompt: "How did these land?",
  items: [
    { id: "a", label: "Film A" },
    { id: "b", label: "Film B" },
  ],
  cutoff: 1,
};

/** A backend whose turn asks one ranking question and ends when it settles. */
function rankBackend() {
  let settled: { result?: AskUserRankResult; error?: Error } | null = null;
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
    async startTurn(req) {
      req.bridge.emit({ type: "session_info", sessionId: "s1", isNew: true, providerId: "default" });
      try {
        settled = { result: await req.bridge.askUserRank!("rank-1", SPEC) };
      } catch (err) {
        settled = { error: err as Error };
      }
      req.bridge.emit({
        type: "result",
        sessionId: "s1",
        outcome: "success",
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    },
    async listSessions() {
      return [];
    },
    async getHistory() {
      return [];
    },
  };
  return { backend, settled: () => settled };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send: (data: string) => sent.push(JSON.parse(data) as ServerMessage) };
  return { ws, sent };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

const openEvt = {} as Event;
const closeEvt = { code: 1001 } as CloseEvent;

describe("ask_user_rank over the socket", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("the request goes out whole and the answer resolves the turn's promise", async () => {
    const { backend, settled } = rankBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    expect(c.sent.find((frame) => frame.type === "server_hello")).toMatchObject({ capabilities: { askUserRank: true } });
    await handleClientMessage(c.ws, { type: "chat_message", text: "rank" });
    await waitFor(() => c.sent.some((f) => f.type === "ask_user_rank_request"));

    const frame = c.sent.find((f) => f.type === "ask_user_rank_request") as Extract<
      ServerMessage,
      { type: "ask_user_rank_request" }
    >;
    expect(frame).toMatchObject({ requestId: "rank-1", ...SPEC });
    expect(frame.turnId).toBeDefined();

    await handleClientMessage(c.ws, {
      type: "ask_user_rank_response",
      requestId: "rank-1",
      submissionId: "sub-1",
      order: ["b", "a"],
      unchanged: false,
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result).toEqual({ order: ["b", "a"], unchanged: false });
    expect(host.coordinator.pendingAskUserRank.size).toBe(0);
    handlers.onClose(closeEvt, c.ws);
  });

  test("a response and cancellation from a different turn leave the pending order untouched", async () => {
    const { backend, settled } = rankBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "rank" });
    await waitFor(() => host.coordinator.pendingAskUserRank.size === 1);
    const frame = c.sent.find((f) => f.type === "ask_user_rank_request")!;
    await handleClientMessage(c.ws, { type: "ask_user_rank_response", requestId: "rank-1", submissionId: "sub-inline-3", order: ["b", "a"], unchanged: false, turnId: "different-turn" });
    await handleClientMessage(c.ws, { type: "ask_user_cancel", requestId: "rank-1", reason: "stale", turnId: "different-turn" });
    expect(host.coordinator.pendingAskUserRank.size).toBe(1);
    expect(settled()).toBeNull();
    await handleClientMessage(c.ws, { type: "ask_user_rank_response", requestId: "rank-1", submissionId: "sub-inline-4", order: ["b", "a"], unchanged: false, turnId: frame.turnId });
    await waitFor(() => settled() !== null);
    expect(settled()!.result?.order).toEqual(["b", "a"]);
    handlers.onClose(closeEvt, c.ws);
  });

  test("ask_user_cancel dismisses a rank card and the turn gets an error", async () => {
    const { backend, settled } = rankBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => host.coordinator.pendingAskUserRank.size === 1);
    const frame = c.sent.find((f) => f.type === "ask_user_rank_request")!;

    await handleClientMessage(c.ws, {
      type: "ask_user_cancel",
      requestId: "rank-1",
      reason: "User dismissed",
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.error?.message).toBe("User dismissed");
    expect(host.coordinator.pendingAskUserRank.size).toBe(0);
    handlers.onClose(closeEvt, c.ws);
  });

  test("a pending rank card survives a disconnect and re-delivers on reconnect", async () => {
    const { backend, settled } = rankBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => host.coordinator.pendingAskUserRank.size === 1);

    handlers.onClose(closeEvt, c1.ws);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.coordinator.pendingAskUserRank.size).toBe(1);
    expect(settled()).toBeNull();

    const c2 = fakeClient();
    const again = createWsHandlers(host);
    await again.onOpen(openEvt, c2.ws);
    const card = c2.sent.find((f) => f.type === "ask_user_rank_request") as
      | Extract<ServerMessage, { type: "ask_user_rank_request" }>
      | undefined;
    expect(card).toMatchObject({ requestId: "rank-1", ...SPEC });

    await handleClientMessage(c2.ws, {
      type: "ask_user_rank_response",
      requestId: "rank-1",
      submissionId: "sub-2",
      order: ["a", "b"],
      unchanged: true,
      turnId: card!.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result).toEqual({ order: ["a", "b"], unchanged: true });
    again.onClose(closeEvt, c2.ws);
  });
});
