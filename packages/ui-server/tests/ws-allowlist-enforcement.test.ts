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
import { createRecordingObservability } from "../src/observability/index";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { handleClientMessage as dispatch } from "../src/ws/dispatch";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import { WsHost, type ToolPermissions } from "../src/ws/host";
import {
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
  setToolPermissionsForTests,
  testHost,
} from "./helpers/test-host";
import { testAuthorization, testPrincipal } from "./helpers/principal";

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

/**
 * The card has to say what the host will do with its answer (#147). The host
 * refuses to remember an "always allow" given outside an enforced allowlist;
 * a card that still offers the button makes that refusal a lie told by the UI.
 * So the frame carries it, and so does the frame re-delivered on reconnect —
 * a card that survives a screen lock must not come back with the button.
 */
describe("the approval frame says whether a grant can be kept", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  type Card = { toolUseId?: string; rememberable?: boolean; turnId?: string };
  const cardsIn = (sent: ServerMessage[]) =>
    sent.filter((f) => f.type === "tool_approval_request") as Card[];

  test("a request outside the enforced allowlist is sent as not rememberable", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    setToolPermissionsForTests(memoryGrants().tp);
    const { host, client } = await startTurn(controls);

    void controls[0]!.request(
      { toolName: "mcp_proxy_tool", input: {}, kind: "tool", outsideEnforcedAllowlist: true },
      "t20"
    );
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);

    const cards = cardsIn(client.sent);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.rememberable).toBe(false);
    controls[0]!.finish();
  });

  test("the same card re-delivered after a reconnect is still not rememberable", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    setToolPermissionsForTests(memoryGrants().tp);
    const { host } = await startTurn(controls);

    void controls[0]!.request(
      { toolName: "mcp_proxy_tool", input: {}, kind: "tool", outsideEnforcedAllowlist: true },
      "t21"
    );
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);

    const reconnected = fakeClient();
    await createWsHandlers(host, testPrincipal()).onOpen(openEvt, reconnected.ws);
    const cards = cardsIn(reconnected.sent);
    expect(cards.map((c) => c.toolUseId)).toEqual(["t21"]);
    expect(cards[0]!.rememberable).toBe(false);
    controls[0]!.finish();
  });

  test("an unmarked request carries no marking, first time or re-delivered", async () => {
    // Absent is today's frame: the client falls back to kind alone, which is
    // what an older host would have sent it anyway.
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    setToolPermissionsForTests(memoryGrants().tp);
    const { host, client } = await startTurn(controls);

    void controls[0]!.request({ toolName: "mcp_proxy_tool", input: {}, kind: "tool" }, "t22");
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const reconnected = fakeClient();
    await createWsHandlers(host, testPrincipal()).onOpen(openEvt, reconnected.ws);

    for (const card of [...cardsIn(client.sent), ...cardsIn(reconnected.sent)]) {
      expect("rememberable" in card).toBe(false);
    }
    expect(cardsIn(reconnected.sent)).toHaveLength(1);
    controls[0]!.finish();
  });
});

/**
 * The refusal to remember has to be visible. The read side already records a
 * grant it declines to apply; the write side refusing the user's own "always"
 * is the same gap facing the other way, and it is the one a person will
 * actually notice — they pressed the button.
 *
 * Built on its own host rather than the shared helper because this asserts on
 * log records, which need a recording observability.
 */
describe("a refused always-allow is recorded", () => {
  // Closed here rather than at the end of each body: a failing assertion
  // would otherwise leak the host and its db into the rest of the file.
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  /** `store: false` builds a host with NO grants store, the embedder path. */
  function setup(initial: string[] = [], store = true) {
    const db = createUiDb(":memory:");
    const observability = createRecordingObservability();
    const { backend, controls } = permissionBackend();
    const grants = new Set(initial);
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
      ...(store
        ? {
            toolPermissions: {
              isAutoAllowed: (name: string) => grants.has(name),
              add: (name: string) => grants.add(name),
            },
          }
        : {}),
    });
    close = () => {
      host.close();
      db.close();
    };
    return { host, observability, controls, grants };
  }

  async function openTurn(host: WsHost, controls: TurnControl[]) {
    const handlers = createWsHandlers(host, testPrincipal());
    const client = fakeClient();
    await handlers.onOpen(openEvt, client.ws);
    await dispatch(host, client.ws, { type: "chat_message", text: "hi" }, {
      principal: testPrincipal(),
      authorization: testAuthorization(),
    });
    await waitFor(() => controls.length === 1);
    return client;
  }

  test("refusing to remember an enforced-posture grant emits a record", async () => {
    const { host, observability, controls, grants } = setup();
    const client = await openTurn(host, controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request(
        {
          toolName: "mcp_proxy_tool",
          input: {},
          kind: "tool",
          outsideEnforcedAllowlist: true,
        },
        "t10"
      )
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { turnId?: string }
      | undefined;

    await dispatch(
      host,
      client.ws,
      { type: "tool_approval", toolUseId: "t10", always: true, turnId: card!.turnId },
      { principal: testPrincipal(), authorization: testAuthorization() }
    );
    await waitFor(() => decision !== null);

    expect(grants.size).toBe(0);
    const records = observability.logs
      .find({ scope: "ws" })
      .filter((r) => r.body === "always-allow not remembered");
    expect(records).toHaveLength(1);
    expect(records[0]!.attributes["tool.name"]).toBe("mcp_proxy_tool");
    expect(records[0]!.attributes["toolUse.id"]).toBe("t10");
    expect(records[0]!.attributes.reason).toBe("outside this turn's enforced allowlist");

    controls[0]!.finish();
  });

  test("a kind 'command' always from a tampering client is recorded too", async () => {
    const { host, observability, controls, grants } = setup();
    const client = await openTurn(host, controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request({ toolName: "Bash", input: { command: "rm -rf x" }, kind: "command" }, "t11")
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { turnId?: string }
      | undefined;

    await dispatch(
      host,
      client.ws,
      { type: "tool_approval", toolUseId: "t11", always: true, turnId: card!.turnId },
      { principal: testPrincipal(), authorization: testAuthorization() }
    );
    await waitFor(() => decision !== null);

    expect(grants.size).toBe(0);
    const records = observability.logs
      .find({ scope: "ws" })
      .filter((r) => r.body === "always-allow not remembered");
    expect(records).toHaveLength(1);
    expect(records[0]!.attributes["tool.name"]).toBe("Bash");
    expect(records[0]!.attributes.reason).toBe("per-use confirmation");

    controls[0]!.finish();
  });

  test("with no grants store at all, the refusal is recorded rather than silent", async () => {
    // The host that has nowhere to put a grant used to take the "remembered"
    // branch, write nothing through an optional chain, log nothing, and still
    // stamp the activity record `always_allow`. That is the silent refusal
    // this whole block exists to rule out, so it is a reason like any other.
    const { host, observability, controls } = setup([], false);
    const client = await openTurn(host, controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request({ toolName: "mcp_proxy_tool", input: {}, kind: "tool" }, "t13")
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { turnId?: string }
      | undefined;

    await dispatch(
      host,
      client.ws,
      { type: "tool_approval", toolUseId: "t13", always: true, turnId: card!.turnId },
      { principal: testPrincipal(), authorization: testAuthorization() }
    );
    await waitFor(() => decision !== null);

    expect(decision!.behavior).toBe("allow");
    const records = observability.logs
      .find({ scope: "ws" })
      .filter((r) => r.body === "always-allow not remembered");
    expect(records).toHaveLength(1);
    expect(records[0]!.attributes.reason).toBe("no grant store configured");

    controls[0]!.finish();
  });

  test("an always the host DOES honour emits no such record", async () => {
    const { host, observability, controls, grants } = setup();
    const client = await openTurn(host, controls);

    let decision: PermissionDecision | null = null;
    void controls[0]!
      .request({ toolName: "mcp_proxy_tool", input: {}, kind: "tool" }, "t12")
      .then((d) => {
        decision = d;
      });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    const card = client.sent.find((f) => f.type === "tool_approval_request") as
      | { turnId?: string }
      | undefined;

    await dispatch(
      host,
      client.ws,
      { type: "tool_approval", toolUseId: "t12", always: true, turnId: card!.turnId },
      { principal: testPrincipal(), authorization: testAuthorization() }
    );
    await waitFor(() => decision !== null);

    expect(grants.has("mcp_proxy_tool")).toBe(true);
    expect(
      observability.logs.find({ scope: "ws" }).filter((r) => r.body === "always-allow not remembered")
    ).toHaveLength(0);

    controls[0]!.finish();
  });
});
