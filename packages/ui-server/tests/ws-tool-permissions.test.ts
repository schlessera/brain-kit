/**
 * "Always allow" tool grants: a remembered tool is auto-approved without a
 * card, `always: true` on an approval persists the grant, and kind "command"
 * confirmations (destructive-bash patterns) can neither be remembered nor
 * auto-answered — the seatbelt stays per-use. Plus the management routes.
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
import { createToolPermissionRoutes } from "../src/routes/tool-permissions";
import { getAutoAllowedTools, setAutoAllowedTools } from "../src/db/settings";
import {
  closeDb,
  getDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
  setToolPermissionsForTests,
  testHost,
} from "./helpers/test-host";

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
  const handlers = createWsHandlers(host);
  const client = fakeClient();
  await handlers.onOpen(openEvt, client.ws);
  await handleClientMessage(client.ws, { type: "chat_message", text: "hi" });
  await waitFor(() => controls.length === 1);
  return { host, client };
}

describe("always-allow grants over the ws bridge", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("a remembered tool auto-approves with no card", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp } = memoryGrants(["mcp__github__create_issue"]);
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    const decision = await controls[0]!.request(
      { toolName: "mcp__github__create_issue", input: {}, kind: "tool" },
      "t1"
    );
    expect(decision.behavior).toBe("allow");
    expect(host.coordinator.pendingApprovals.size).toBe(0);
    expect(client.sent.some((f) => f.type === "tool_approval_request")).toBe(false);
    controls[0]!.finish();
  });

  test("a kind 'command' request is NEVER auto-answered, even when remembered", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp } = memoryGrants(["Bash"]);
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request({ toolName: "Bash", input: { command: "rm -rf x" }, kind: "command" }, "t2")
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    expect(decision).toBeNull();
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { kind?: string; turnId?: string }
      | undefined;
    expect(card?.kind).toBe("command");

    await handleClientMessage(client.ws, {
      type: "tool_approval",
      toolUseId: "t2",
      turnId: card!.turnId,
    });
    await waitFor(() => decision !== null);
    controls[0]!.finish();
  });

  test("always: true persists the grant; the next request needs no card", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp, set } = memoryGrants();
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request({ toolName: "mcp_proxy_tool", input: {}, kind: "tool" }, "t3")
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
    expect(decision!.behavior).toBe("allow");
    expect(set.has("mcp_proxy_tool")).toBe(true);

    // Second request for the same tool: answered without a card.
    const second = await controls[0]!.request(
      { toolName: "mcp_proxy_tool", input: {}, kind: "tool" },
      "t4"
    );
    expect(second.behavior).toBe("allow");
    expect(host.coordinator.pendingApprovals.size).toBe(0);
    controls[0]!.finish();
  });

  test("always: true on a kind 'command' approval is NOT persisted", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp, set } = memoryGrants();
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request({ toolName: "Bash", input: { command: "rm -rf x" }, kind: "command" }, "t5")
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { turnId?: string }
      | undefined;

    // A tampering client sends always anyway — the host refuses to remember.
    await handleClientMessage(client.ws, {
      type: "tool_approval",
      toolUseId: "t5",
      always: true,
      turnId: card!.turnId,
    });
    await waitFor(() => decision !== null);
    expect(decision!.behavior).toBe("allow"); // this one call still runs
    expect(set.size).toBe(0); // but nothing is remembered
    controls[0]!.finish();
  });
});

describe("tool-permission routes + settings persistence", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("settings round-trip dedupes and sorts", () => {
    const db = getDb();
    setAutoAllowedTools(db, ["b_tool", "a_tool", "b_tool", ""]);
    expect(getAutoAllowedTools(db)).toEqual(["a_tool", "b_tool"]);
  });

  test("GET lists, DELETE revokes, unknown 404s", async () => {
    const db = getDb();
    setAutoAllowedTools(db, ["web_search", "mcp__github__create_issue"]);
    const app = createToolPermissionRoutes({ db });

    let res = await app.request("/tool-permissions");
    expect(((await res.json()) as { tools: string[] }).tools).toEqual([
      "mcp__github__create_issue",
      "web_search",
    ]);

    res = await app.request("/tool-permissions/web_search", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(getAutoAllowedTools(db)).toEqual(["mcp__github__create_issue"]);

    res = await app.request("/tool-permissions/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
