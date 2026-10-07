/**
 * turnId correlation (protocol rev 2). The host mints a turnId per turn,
 * stamps it on every turn-scoped frame, re-mints it for a queued follow-up,
 * and refuses an inbound reply whose echoed turnId belongs to a different
 * turn.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PROTOCOL_REV_CLIENT_ECHO } from "@schlessera/brain-ui-sdk/protocol";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { turnIdMatches } from "../src/ws/dispatch";
import { createWsHandlers } from "../src/ws/connection";
import { testHost } from "./helpers/test-host";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "../src/ws/clients";
import {
  addClient,
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
} from "./helpers/test-host";
import { testPrincipal } from "./helpers/principal";

interface TurnControl {
  toolUseId: string;
  approve: () => Promise<{ behavior: string }>;
  finish: () => void;
}

/** Backend that raises one tool-approval per turn, then waits to be finished. */
function approvalBackend() {
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
        approve: () =>
          req.bridge.requestPermission({
            toolUseId,
            toolName: "Write",
            input: {},
          }) as Promise<{ behavior: string }>,
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

const turnIdOf = (f: ServerMessage): string | undefined =>
  (f as { turnId?: string }).turnId;

describe("turnId stamping and correlation", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("turn-scoped frames carry a turnId; two sessions get distinct ids", async () => {
    const { backend, controls } = approvalBackend();
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    void handleClientMessage(ws, { type: "chat_message", text: "A" });
    void handleClientMessage(ws, { type: "chat_message", text: "B" });
    await waitFor(() => controls.length === 2);
    await waitFor(() => sent.filter((f) => f.type === "session_info").length === 2);

    const infos = sent.filter((f) => f.type === "session_info");
    const ids = infos.map(turnIdOf);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);

    controls[0]!.finish();
    controls[1]!.finish();
  });

  test("an approval echoing a FOREIGN turnId does not resolve the pending request", async () => {
    const { backend, controls } = approvalBackend();
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    void handleClientMessage(ws, { type: "chat_message", text: "A" });
    await waitFor(() => controls.length === 1);

    const decided = { value: null as string | null };
    void controls[0]!.approve().then((d) => {
      decided.value = d.behavior;
    });
    await waitFor(() => sent.some((f) => f.type === "tool_approval_request"));
    const req = sent.find((f) => f.type === "tool_approval_request")!;
    const realTurnId = turnIdOf(req)!;
    expect(realTurnId).toBeTruthy();

    // Stale/foreign echo: ignored, promise still pending.
    await handleClientMessage(ws, {
      type: "tool_approval",
      toolUseId: controls[0]!.toolUseId,
      turnId: "some-other-turn",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(decided.value).toBeNull();

    // Correct echo resolves it.
    await handleClientMessage(ws, {
      type: "tool_approval",
      toolUseId: controls[0]!.toolUseId,
      turnId: realTurnId,
    });
    await waitFor(() => decided.value !== null);
    expect(decided.value).toBe("allow");

    controls[0]!.finish();
  });

  test("a reply with NO turnId still resolves (the echo is optional)", async () => {
    const { backend, controls } = approvalBackend();
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    void handleClientMessage(ws, { type: "chat_message", text: "A" });
    await waitFor(() => controls.length === 1);

    const decided = { value: null as string | null };
    void controls[0]!.approve().then((d) => {
      decided.value = d.behavior;
    });
    await waitFor(() => sent.some((f) => f.type === "tool_approval_request"));

    await handleClientMessage(ws, { type: "tool_denial", toolUseId: controls[0]!.toolUseId, message: "no" });
    await waitFor(() => decided.value !== null);
    expect(decided.value).toBe("deny");

    controls[0]!.finish();
  });
});

describe("the rev-3 deprecation window", () => {
  // The real predicate from dispatch.ts, not a copy of it — a mirrored
  // version would pass long after the rule it mirrors had changed.

  test("a client that declares nothing is still tolerated without an echo", () => {
    // Every client older than client_hello. Enforcing on them would break
    // every tool approval in a UI that predates this release.
    expect(turnIdMatches({ turnId: "t1" }, undefined, false)).toBe(true);
  });

  test("a client that declared rev 3 must echo", () => {
    // It promised to. Silence means the reply cannot be correlated, and
    // guessing is exactly what the echo exists to stop.
    expect(turnIdMatches({ turnId: "t1" }, undefined, true)).toBe(false);
    expect(turnIdMatches({ turnId: "t1" }, "t1", true)).toBe(true);
  });

  test("a WRONG echo is refused whatever the client declared", () => {
    // A stale echo from before a reconnect would otherwise resolve a
    // different turn's pending promise.
    expect(turnIdMatches({ turnId: "t1" }, "t-other", false)).toBe(false);
    expect(turnIdMatches({ turnId: "t1" }, "t-other", true)).toBe(false);
  });


});

describe("per-connection state through the socket handlers", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test.each([undefined, 2, 3, 99])("the socket echo gate is keyed on declared revision %s", async (revision) => {
    const { backend, controls } = approvalBackend();
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);
    const handlers = createWsHandlers(testHost(), testPrincipal());
    const send = (msg: unknown) =>
      handlers.onMessage({ data: JSON.stringify(msg) } as MessageEvent, ws);
    if (revision !== undefined) {
      send({ type: "client_hello", protocolRev: revision, capabilities: {} });
    }
    send({ type: "chat_message", text: "A" });
    await waitFor(() => controls.length === 1);
    let decision: string | null = null;
    void controls[0]!.approve().then((result) => {
      decision = result.behavior;
    });
    await waitFor(() => sent.some((frame) => frame.type === "tool_approval_request"));
    const turnId = turnIdOf(sent.find((frame) => frame.type === "tool_approval_request")!);
    send({ type: "tool_approval", toolUseId: controls[0]!.toolUseId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decision).toBe(revision === 3 || revision === 99 ? null : "allow");
    if (decision === null) {
      send({ type: "tool_approval", toolUseId: controls[0]!.toolUseId, turnId });
      await waitFor(() => decision !== null);
    }
    expect(decision).toBe("allow");
    controls[0]!.finish();
  });

  // Regression: createWsHandlers used to build its ConnectionState and then
  // NOT pass it to handleClientMessage, so client_hello wrote the declared
  // revision into a throwaway object and every later frame was dispatched at
  // the rev-2 default — the rev-3 echo requirement was never enforced on a
  // real socket. Only this path exercises connection.ts; the tests above call
  // the dispatcher directly and could never see it.
  test("a rev-3 hello on the socket makes a later echo-less approval refusable", async () => {
    const { backend, controls } = approvalBackend();
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);
    const handlers = createWsHandlers(testHost(), testPrincipal());
    const send = (msg: unknown) =>
      handlers.onMessage({ data: JSON.stringify(msg) } as MessageEvent, ws);

    send({ type: "client_hello", protocolRev: PROTOCOL_REV_CLIENT_ECHO, capabilities: {} });
    send({ type: "chat_message", text: "A" });
    await waitFor(() => controls.length === 1);

    const decided = { value: null as string | null };
    void controls[0]!.approve().then((d) => {
      decided.value = d.behavior;
    });
    await waitFor(() => sent.some((f) => f.type === "tool_approval_request"));
    const realTurnId = turnIdOf(sent.find((f) => f.type === "tool_approval_request")!)!;

    // No echo from a client that declared rev 3: must NOT resolve.
    send({ type: "tool_approval", toolUseId: controls[0]!.toolUseId });
    await new Promise((r) => setTimeout(r, 20));
    expect(decided.value).toBeNull();

    // The genuine echo resolves it.
    send({ type: "tool_approval", toolUseId: controls[0]!.toolUseId, turnId: realTurnId });
    await waitFor(() => decided.value !== null);
    expect(decided.value).toBe("allow");

    controls[0]!.finish();
  });
});
