/**
 * Approvals survive disconnects and re-deliver on reconnect.
 *
 * On a phone the socket drops at every screen lock. Before this behavior
 * existed, that ordinary event silently DENIED every pending approval
 * ("Client disconnected"), and an approval raised while no client was
 * attached parked invisibly until the turn timeout killed the whole turn.
 * Now approvals and ask-user cards hold across the gap — bounded by the turn
 * timeout — and the card reappears on the next connection. Location and mask
 * requests still fail fast: they need a live client at that instant.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, LocationFix } from "@schlessera/brain-ui-sdk/server";
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

interface TurnControl {
  toolUseId: string;
  requestApproval: () => Promise<{ behavior: string; message?: string }>;
  requestLocation: () => Promise<LocationFix>;
  finish: () => void;
}

/** Backend whose turn raises interactive requests on the test's command. */
function interactiveBackend() {
  const controls: TurnControl[] = [];
  let counter = 0;

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
      const sessionId = req.sessionId ?? `s${++counter}`;
      req.bridge.emit({
        type: "session_info",
        sessionId,
        isNew: !req.sessionId,
        providerId: "default",
      });
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      const toolUseId = `tool-${controls.length}`;
      controls.push({
        toolUseId,
        requestApproval: () =>
          req.bridge.requestPermission({
            toolUseId,
            toolName: "Write",
            input: { file_path: "notes/a.md" },
          }) as Promise<{ behavior: string; message?: string }>,
        requestLocation: () => req.bridge.getLocation!(),
        finish: () => {
          req.bridge.emit({
            type: "result",
            sessionId,
            outcome: "success",
            costUsd: 0,
            durationMs: 1,
            numTurns: 1,
            isError: false,
          });
          resolveDone();
        },
      });
      await done;
    },
    async listSessions() {
      return [];
    },
    async getHistory() {
      return [];
    },
  };
  return { backend, controls };
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

describe("approval persistence across disconnects", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("a pending approval survives the last client leaving and re-delivers on reconnect", async () => {
    const { backend, controls } = interactiveBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);

    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "hi" });
    await waitFor(() => controls.length === 1);

    let decision: { behavior: string; message?: string } | null = null;
    void controls[0]!.requestApproval().then((d) => {
      decision = d;
    });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);

    // Screen lock: the last client drops. The approval must NOT be denied.
    handlers.onClose(closeEvt, c1.ws);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.coordinator.pendingApprovals.size).toBe(1);
    expect(decision).toBeNull();

    // Reconnect: the card is re-delivered with its original identity.
    const c2 = fakeClient();
    await handlers.onOpen(openEvt, c2.ws);
    const card = c2.sent.find((f) => f.type === "tool_approval_request") as
      | { toolUseId: string; toolName: string; turnId?: string }
      | undefined;
    expect(card).toBeDefined();
    expect(card!.toolUseId).toBe("tool-0");
    expect(card!.toolName).toBe("Write");
    expect(card!.turnId).toBeDefined();

    // Answering through the normal dispatch path resolves the held promise.
    await handleClientMessage(c2.ws, {
      type: "tool_approval",
      toolUseId: "tool-0",
      turnId: card!.turnId,
    });
    await waitFor(() => decision !== null);
    expect(decision!.behavior).toBe("allow");

    controls[0]!.finish();
  });

  test("an approval raised while NO client is attached parks and delivers on connect", async () => {
    const { backend, controls } = interactiveBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);

    // Start the turn with a client, then drop it BEFORE the approval exists.
    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "hi" });
    await waitFor(() => controls.length === 1);
    handlers.onClose(closeEvt, c1.ws);

    let decision: { behavior: string } | null = null;
    void controls[0]!.requestApproval().then((d) => {
      decision = d;
    });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    expect(decision).toBeNull(); // parked, not denied

    const c2 = fakeClient();
    await handlers.onOpen(openEvt, c2.ws);
    const card = c2.sent.find((f) => f.type === "tool_approval_request");
    expect(card).toBeDefined();

    controls[0]!.finish();
  });

  test("a pending location request is REJECTED when the last client leaves", async () => {
    const { backend, controls } = interactiveBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);

    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "hi" });
    await waitFor(() => controls.length === 1);

    let rejection: Error | null = null;
    controls[0]!.requestLocation().catch((e: Error) => {
      rejection = e;
    });
    await waitFor(() => host.coordinator.pendingLocation.size === 1);

    handlers.onClose(closeEvt, c1.ws);
    await waitFor(() => rejection !== null);
    expect(rejection!.message).toContain("Client disconnected");
    expect(host.coordinator.pendingLocation.size).toBe(0);

    controls[0]!.finish();
  });

  test("cancel and turn teardown still drain pending approvals with a reason", async () => {
    const { backend, controls } = interactiveBackend();
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host);

    const c1 = fakeClient();
    await handlers.onOpen(openEvt, c1.ws);
    await handleClientMessage(c1.ws, { type: "chat_message", text: "hi" });
    await waitFor(() => controls.length === 1);

    let decision: { behavior: string; message?: string } | null = null;
    void controls[0]!.requestApproval().then((d) => {
      decision = d;
    });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);

    await handleClientMessage(c1.ws, { type: "cancel" });
    await waitFor(() => decision !== null);
    expect(decision!.behavior).toBe("deny");
    expect(decision!.message).toBe("Cancelled by user");
    expect(host.coordinator.pendingApprovals.size).toBe(0);
  });
});
