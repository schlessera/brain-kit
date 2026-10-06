/**
 * `ask_user_form` over the socket (#585): the request goes out as one frame,
 * typed answers come back by node id, a dismissal rejects through the same
 * `ask_user_cancel` frame `ask_user` uses, and a pending card survives a
 * disconnect and re-delivers on reconnect, as an `ask_user` card does.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  AskUserFormSpec,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type {
  AgentBackend,
  AskUserFormResult,
} from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers as createAuthorizedWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import {
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
  testHost,
} from "./helpers/test-host";
import { WsHost } from "../src/ws/host.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createUiDb } from "../src/db/client.js";
import { handleClientMessage as dispatch } from "../src/ws/dispatch.js";
import { testAuthorization } from "./helpers/principal.js";
import { testPrincipal } from "./helpers/principal";

const createWsHandlers = (host: ReturnType<typeof testHost>) =>
  createAuthorizedWsHandlers(host, testPrincipal());

const SPEC: AskUserFormSpec = {
  prompt: "Choose",
  nodes: [
    {
      id: "choice",
      kind: "single",
      prompt: "Which?",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

/** A backend whose turn asks one conditional form and ends when it settles. */
function formBackend(spec = SPEC, duplicate = false) {
  let duplicateError: Error | null = null;
  let settled: { result?: AskUserFormResult; error?: Error } | null = null;
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
      req.bridge.emit({
        type: "session_info",
        sessionId: "s1",
        isNew: true,
        providerId: "default",
      });
      try {
        const pending = req.bridge.askUserForm!("form-1", spec);
        if (duplicate)
          try {
            await req.bridge.askUserForm!("form-1", spec);
          } catch (error) {
            duplicateError = error as Error;
          }
        settled = { result: await pending };
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
  return {
    backend,
    settled: () => settled,
    duplicateError: () => duplicateError,
  };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = {
    send: (data: string) => sent.push(JSON.parse(data) as ServerMessage),
  };
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

describe("ask_user_form over the socket", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("the request goes out whole and the answer resolves the turn's promise", async () => {
    const { backend, settled } = formBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    expect(c.sent.find((frame) => frame.type === "server_hello")).toMatchObject(
      { capabilities: { askUserForm: true } },
    );
    await handleClientMessage(c.ws, { type: "chat_message", text: "rank" });
    await waitFor(() => c.sent.some((f) => f.type === "ask_user_form_request"));

    const frame = c.sent.find(
      (f) => f.type === "ask_user_form_request",
    ) as Extract<ServerMessage, { type: "ask_user_form_request" }>;
    expect(frame).toMatchObject({ requestId: "form-1", ...SPEC });
    expect(frame.turnId).toBeDefined();

    await handleClientMessage(c.ws, {
      type: "ask_user_form_response",
      requestId: "form-1",
      submissionId: "sub-8",
      answers: { choice: { value: "B" } },
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result).toEqual({ answers: { choice: { value: "B" } } });
    expect(host.coordinator.pendingAskUserForm.size).toBe(0);
    handlers.onClose(closeEvt, c.ws);
  });

  test("a duplicate form id rejects before emitting and preserves the original answer promise", async () => {
    const { backend, settled, duplicateError } = formBackend(SPEC, true);
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "Choose" });
    await waitFor(() => duplicateError() !== null);
    expect(duplicateError()?.message).toBe("Duplicate ask-user request id");
    const requests = c.sent.filter(
      (frame) => frame.type === "ask_user_form_request",
    );
    expect(requests).toHaveLength(1);
    expect(
      c.sent.filter(
        (frame) =>
          frame.type === "status" && frame.detail === "Waiting for your input",
      ),
    ).toHaveLength(1);
    expect(host.coordinator.pendingAskUserForm.size).toBe(1);
    expect(settled()).toBeNull();
    await handleClientMessage(c.ws, {
      type: "ask_user_form_response",
      requestId: "form-1",
      submissionId: "sub-9",
      answers: { choice: { value: "B" } },
      turnId: requests[0]!.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()?.result).toEqual({ answers: { choice: { value: "B" } } });
    handlers.onClose(closeEvt, c.ws);
  });

  test("a response and cancellation from a different turn leave the pending form untouched", async () => {
    const { backend, settled } = formBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "rank" });
    await waitFor(() => host.coordinator.pendingAskUserForm.size === 1);
    const frame = c.sent.find((f) => f.type === "ask_user_form_request")!;
    await handleClientMessage(c.ws, {
      type: "ask_user_form_response",
      requestId: "form-1",
      submissionId: "sub-10",
      answers: { choice: { value: "B" } },
      turnId: "different-turn",
    });
    await handleClientMessage(c.ws, {
      type: "ask_user_cancel",
      requestId: "form-1",
      reason: "stale",
      turnId: "different-turn",
    });
    expect(host.coordinator.pendingAskUserForm.size).toBe(1);
    expect(settled()).toBeNull();
    await handleClientMessage(c.ws, {
      type: "ask_user_form_response",
      requestId: "form-1",
      submissionId: "sub-11",
      answers: { choice: { value: "B" } },
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result?.answers).toEqual({ choice: { value: "B" } });
    handlers.onClose(closeEvt, c.ws);
  });

  test("ask_user_cancel dismisses a form card and the turn gets an error", async () => {
    const { backend, settled } = formBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c = fakeClient();
    await handlers.onOpen(openEvt, c.ws);
    await handleClientMessage(c.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => host.coordinator.pendingAskUserForm.size === 1);
    const frame = c.sent.find((f) => f.type === "ask_user_form_request")!;

    await handleClientMessage(c.ws, {
      type: "ask_user_cancel",
      requestId: "form-1",
      reason: "User dismissed",
      turnId: frame.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.error?.message).toBe("User dismissed");
    expect(host.coordinator.pendingAskUserForm.size).toBe(0);
    handlers.onClose(closeEvt, c.ws);
  });

  test("a pending form card survives a disconnect and re-delivers on reconnect", async () => {
    const { backend, settled } = formBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);
    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "rate" });
    await waitFor(() => host.coordinator.pendingAskUserForm.size === 1);

    handlers.onClose(closeEvt, c1.ws);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.coordinator.pendingAskUserForm.size).toBe(1);
    expect(settled()).toBeNull();

    const c2 = fakeClient();
    const again = createWsHandlers(host);
    await again.onOpen(openEvt, c2.ws);
    const card = c2.sent.find((f) => f.type === "ask_user_form_request") as
      Extract<ServerMessage, { type: "ask_user_form_request" }> | undefined;
    expect(card).toMatchObject({ requestId: "form-1", ...SPEC });

    await handleClientMessage(c2.ws, {
      type: "ask_user_form_response",
      requestId: "form-1",
      submissionId: "sub-12",
      answers: { choice: { value: "A" } },
      turnId: card!.turnId,
    });
    await waitFor(() => settled() !== null);
    expect(settled()!.result).toEqual({ answers: { choice: { value: "A" } } });
    again.onClose(closeEvt, c2.ws);
  });
});

test("environment overrides admit a deeper, larger form through the real host and socket", async () => {
  const spec: AskUserFormSpec = {
    prompt: "A longer path",
    nodes: [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `n${i}`,
        kind: "single" as const,
        prompt: "Continue?",
        options: Array.from({ length: 9 }, (_, j) => ({ label: String(j) })),
        ...(i ? { showIf: { node: `n${i - 1}`, anyOf: ["0"] } } : {}),
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `note${i}`,
        kind: "text" as const,
        prompt: "A note?",
        required: false,
      })),
    ],
  };
  const config = resolveServerConfig({
    BRAIN_UI_ASK_USER_FORM_MAX_DEPTH: "4",
    BRAIN_UI_ASK_USER_FORM_MAX_NODES: "13",
    BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS: "9",
  });
  for (const limits of [undefined, config.askUserFormLimits]) {
    const db = createUiDb(":memory:");
    const { backend, settled } = formBackend(spec);
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], "fake"),
      catalog: createSessionCatalog(() => db),
      askUserFormLimits: limits,
    });
    const c = fakeClient();
    const handlers = createWsHandlers(host);
    const context = {
      principal: testPrincipal(),
      authorization: testAuthorization(),
    };
    try {
      await handlers.onOpen(openEvt, c.ws);
      await dispatch(
        host,
        c.ws,
        { type: "chat_message", text: "Choose" },
        context,
      );
      await waitFor(
        () =>
          settled() !== null || host.coordinator.pendingAskUserForm.size === 1,
      );
      const frame = c.sent.find((f) => f.type === "ask_user_form_request");
      if (!limits) {
        expect(frame).toBeUndefined();
        expect(settled()?.error?.message).toContain("maxNodes");
      } else {
        expect(frame).toMatchObject({ requestId: "form-1", nodes: spec.nodes });
        expect(host.coordinator.pendingAskUserForm.size).toBe(1);
        await dispatch(
          host,
          c.ws,
          {
            type: "ask_user_form_response",
            requestId: "form-1",
            submissionId: "sub-13",
            answers: { n0: { value: "1" } },
            turnId: frame!.turnId,
          },
          context,
        );
        await waitFor(() => settled() !== null);
        expect(settled()?.result).toEqual({ answers: { n0: { value: "1" } } });
      }
    } finally {
      handlers.onClose(closeEvt, c.ws);
      host.close();
      db.close();
    }
  }
});
