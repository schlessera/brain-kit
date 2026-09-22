/**
 * A remembered "always allow" grant is scoped to the posture it was given
 * under (#124). When the backend says the turn's enforced allowlist leaves a
 * tool out, the host neither answers the request from its grant store nor adds
 * to that store from the answer — in both directions, because a grant made
 * inside a narrower posture would widen every turn the user was not looking at.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type {
  AgentBackend,
  PermissionDecision,
  PermissionRequest,
} from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import type { ToolPermissions } from "../src/ws/host";
import {
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
  setToolPermissionsForTests,
  testHost,
} from "./helpers/test-host";
import { testPrincipal } from "./helpers/principal";

const REMEMBERED_TOOL = "mcp__github__create_issue";

interface TurnControl {
  request: (req: Omit<PermissionRequest, "toolUseId">, id: string) => Promise<PermissionDecision>;
  finish: () => void;
}

function permissionBackend() {
  const controls: TurnControl[] = [];
  const backend: AgentBackend = {
    id: "fake",
    capabilities: {
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: false,
      costReporting: true,
      concurrentSessions: true,
      followUp: false,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn(req) {
      const sessionId = req.sessionId ?? "s1";
      req.bridge.emit({ type: "session_info", sessionId, isNew: true, providerId: "default" });
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      controls.push({
        request: (r, id) => req.bridge.requestPermission({ ...r, toolUseId: id }),
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

/** In-memory grants store mirroring the app's db-backed one. */
function memoryGrants(initial: string[] = []) {
  const set = new Set(initial);
  const tp: ToolPermissions = {
    isAutoAllowed: (name) => set.has(name),
    add: (name) => set.add(name),
  };
  return { tp, set };
}

const openEvt = {} as Event;

async function startTurn(controls: TurnControl[]) {
  const host = testHost();
  const handlers = createWsHandlers(host, testPrincipal());
  const client = fakeClient();
  await handlers.onOpen(openEvt, client.ws);
  await handleClientMessage(client.ws, { type: "chat_message", text: "hi" });
  await waitFor(() => controls.length === 1);
  return { host, client };
}

describe("remembered grants under an enforced allowlist", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("a remembered tool outside the turn's enforced allowlist still raises a card", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp } = memoryGrants([REMEMBERED_TOOL]);
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request(
        {
          toolName: REMEMBERED_TOOL,
          input: {},
          kind: "tool",
          outsideEnforcedAllowlist: true,
        },
        "t1"
      )
      .then((d) => {
        decision = d;
      });

    // The grant does not answer it. An auto-answer is synchronous, so after a
    // settle the request must still be open — this is the assertion the
    // re-admission fails: it resolves `{ behavior: "allow" }` before any card
    // exists.
    await new Promise((r) => setTimeout(r, 20));
    expect(decision).toBeNull();
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { toolName?: string; turnId?: string }
      | undefined;
    expect(card?.toolName).toBe(REMEMBERED_TOOL);

    // And the decision the user takes is the one that applies.
    await handleClientMessage(client.ws, {
      type: "tool_denial",
      toolUseId: "t1",
      message: "Not in this posture.",
      turnId: card!.turnId,
    });
    await waitFor(() => decision !== null);
    expect(decision!.behavior).toBe("deny");
    controls[0]!.finish();
  });

  // A request for a tool ON an enforced allowlist arrives unmarked, exactly
  // like one from a turn that declared nothing — the backend only marks what
  // the allowlist leaves out. So this is both cases at once: the grant still
  // answers whenever the marker is absent.
  test("an unmarked request is still auto-approved from the grant store", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp } = memoryGrants([REMEMBERED_TOOL]);
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    const decision = await controls[0]!.request(
      { toolName: REMEMBERED_TOOL, input: {}, kind: "tool" },
      "t2"
    );
    expect(decision.behavior).toBe("allow");
    expect(host.coordinator.pendingApprovals.size).toBe(0);
    expect(client.sent.some((f) => f.type === "tool_approval_request")).toBe(false);
    controls[0]!.finish();
  });

  test("'always allow' answered inside an enforced posture is not remembered", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp, set } = memoryGrants();
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request(
        {
          toolName: "mcp_proxy_tool",
          input: {},
          kind: "tool",
          outsideEnforcedAllowlist: true,
        },
        "t3"
      )
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { turnId?: string }
      | undefined;

    await handleClientMessage(client.ws, {
      type: "tool_approval",
      toolUseId: "t3",
      always: true,
      turnId: card!.turnId,
    });
    await waitFor(() => decision !== null);
    // This call runs — the user approved it — but nothing about the wider
    // posture changed.
    expect(decision!.behavior).toBe("allow");
    expect(set.size).toBe(0);
    controls[0]!.finish();
  });
});
