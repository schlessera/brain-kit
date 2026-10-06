/**
 * `ask_user_list` over the socket (#583): the request goes out as one frame,
 * the answer comes back keyed by item id, a dismissal rejects through the same
 * `ask_user_cancel` frame `ask_user` uses, and a pending card survives a
 * disconnect and re-delivers on reconnect, as an `ask_user` card does.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AskUserListSpec, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, AskUserListResult } from "@schlessera/brain-ui-sdk/server";
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

const SPEC: AskUserListSpec = {
  prompt: "How did these land?",
  scale: [{ label: "loved" }, { label: "meh" }],
  items: [
    { id: "a", label: "Film A" },
    { id: "b", label: "Film B" },
  ],
  allowSkip: true,
  notes: true,
};

/** A backend whose turn asks one list question and ends when it settles. */
function listBackend() {
  let settled: { result?: AskUserListResult; error?: Error } | null = null;
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
        settled = { result: await req.bridge.askUserList!("list-1", SPEC) };
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

describe("ask_user_list over the socket", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("the request goes out whole and the answer resolves the turn's promise", async () => {
    const { backend, settled } = listBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => c.sent.some((f) => f.type === "ask_user_list_request"));

    const frame = c.sent.find((f) => f.type === "ask_user_list_request") as Extract<
      ServerMessage,
      { type: "ask_user_list_request" }
    >;
    expect(frame).toMatchObject({ requestId: "list-1", ...SPEC });
    expect(frame.turnId).toBeDefined();

    await handleClientMessage(c.ws, {
      type: "ask_user_list_response",
      requestId: "list-1",
      submissionId: "sub-6",
      answers: { a: "loved" },
      notes: { b: "later" },
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result).toEqual({ answers: { a: "loved" }, notes: { b: "later" } });
    expect(host.coordinator.pendingAskUserList.size).toBe(0);
    handlers.onClose(closeEvt, c.ws);
  });

  test("ask_user_cancel dismisses a list card and the turn gets an error", async () => {
    const { backend, settled } = listBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => host.coordinator.pendingAskUserList.size === 1);
    const frame = c.sent.find((f) => f.type === "ask_user_list_request")!;

    await handleClientMessage(c.ws, {
      type: "ask_user_cancel",
      requestId: "list-1",
      reason: "User dismissed",
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.error?.message).toBe("User dismissed");
    expect(host.coordinator.pendingAskUserList.size).toBe(0);
    handlers.onClose(closeEvt, c.ws);
  });

  test("a pending list card survives a disconnect and re-delivers on reconnect", async () => {
    const { backend, settled } = listBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => host.coordinator.pendingAskUserList.size === 1);

    handlers.onClose(closeEvt, c1.ws);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.coordinator.pendingAskUserList.size).toBe(1);
    expect(settled()).toBeNull();

    const c2 = fakeClient();
    const again = createWsHandlers(host);
    await again.onOpen(openEvt, c2.ws);
    const card = c2.sent.find((f) => f.type === "ask_user_list_request") as
      | Extract<ServerMessage, { type: "ask_user_list_request" }>
      | undefined;
    expect(card).toMatchObject({ requestId: "list-1", ...SPEC });

    await handleClientMessage(c2.ws, {
      type: "ask_user_list_response",
      requestId: "list-1",
      submissionId: "sub-7",
      answers: { b: "meh" },
      turnId: card!.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result).toEqual({ answers: { b: "meh" } });
    again.onClose(closeEvt, c2.ws);
  });
});
