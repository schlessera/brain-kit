import { approvalRequestFrame } from "../src/ws/frames.js";
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
import { testAuthorization, testPrincipal } from "./helpers/principal";
import { handleClientMessage as dispatchAs } from "../src/ws/dispatch";

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
    add: (name) => { set.add(name); },
  };
  return { tp, set };
}

const googleCard = {
  operation: "gmail.modify", effect: "reversible", tainted: false, entities: ["INBOX"],
  offers: { allow_always: true, allow_for_session: false },
  payload: { message_ids: ["abcdef123"], add_label_ids: [], remove_label_ids: ["INBOX"] },
};

test("google card rememberability follows its offers without a generic store", () => {
  for (const hasStore of [false, true]) {
    for (const offers of [
      { allow_always: true, allow_for_session: false },
      { allow_always: false, allow_for_session: true },
      { allow_always: false, allow_for_session: false },
    ]) {
      const frame = approvalRequestFrame({ toolUseId: "card", toolName: "gmail_modify", kind: "google",
        input: { ...googleCard, tainted: offers.allow_for_session, offers } }, hasStore);
      expect(frame.rememberable !== false).toBe(offers.allow_always || offers.allow_for_session);
    }
    const irreversible = approvalRequestFrame({ toolUseId: "card", toolName: "gmail_trash", kind: "google",
      input: { ...googleCard, operation: "gmail.trash", effect: "irreversible",
        offers: { allow_always: false, allow_for_session: false }, payload: { message_ids: ["abcdef123"] } } }, hasStore);
    expect(irreversible.rememberable).toBe(false);
  }
});

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

  test("google pre-seeded generic grant never bypasses its card", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp } = memoryGrants(["gmail_modify"]);
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);
    let decision: PermissionDecision | null = null;
    void controls[0]!.request({ toolName: "gmail_modify", input: googleCard, kind: "google" }, "google-read")
      .then(value => { decision = value; });
    await waitFor(() => decision !== null || host.coordinator.pendingApprovals.size === 1);
    expect(decision, "GOOGLE_GENERIC_GRANT_MUST_NOT_BYPASS_CARD").toBeNull();
    expect(client.sent.some(frame => frame.type === "tool_approval_request")).toBe(true);
    controls[0]!.finish();
  });

  for (const choice of [{}, { always: true }, { forSession: true }, { always: false, forSession: false }]) {
    for (const echo of [false, true]) {
      test(`google choice ${JSON.stringify(choice)} echo=${echo} forwards distinctly without generic grants`, async () => {
        const { backend, controls } = permissionBackend();
        setBackendForTests(backend);
        const { tp, set } = memoryGrants();
        setToolPermissionsForTests(tp);
        const { host, client } = await startTurn(controls);
        const input = { ...googleCard, tainted: "forSession" in choice && choice.forSession === true,
          offers: { allow_always: !("forSession" in choice && choice.forSession === true), allow_for_session: "forSession" in choice && choice.forSession === true } };
        const decision = controls[0]!.request({ toolName: "gmail_modify", input, kind: "google" }, "google-choice");
        await waitFor(() => host.coordinator.pendingApprovals.size === 1);
        const frame = client.sent.find(frame => frame.type === "tool_approval_request") as { turnId: string };
        const updated = echo ? { updatedInput: input } : {};
        await handleClientMessage(client.ws, { type: "tool_approval", toolUseId: "google-choice", turnId: frame.turnId,
          channel: "card", ...choice, ...updated });
        const answered = await decision;
        expect(set.size, "GOOGLE_CHOICE_MUST_NOT_WRITE_GENERIC_GRANT").toBe(0);
        expect(answered).toEqual({ behavior: "allow", ...choice, ...updated });
        controls[0]!.finish();
      });
    }
  }

  for (const classifier of [undefined, (principal: { id: string }) => principal.id !== "penelope"]) {
    test(`google card answer from a non-owner is ignored and the card stays pending (${classifier ? "owner classifier" : "turn principal"})`, async () => {
      const { backend, controls } = permissionBackend();
      setBackendForTests(backend);
      setToolPermissionsForTests(memoryGrants().tp);
      const { host, client } = await startTurn(controls);
      Object.defineProperty(host, "googleOwner", { value: classifier, configurable: true });
      let decision: PermissionDecision | null = null;
      void controls[0]!.request({ toolName: "gmail_modify", input: googleCard, kind: "google" }, "google-owner").then(value => { decision = value; });
      await waitFor(() => host.coordinator.pendingApprovals.size === 1);
      const frame = client.sent.find(frame => frame.type === "tool_approval_request") as { turnId: string };
      const other = fakeClient();
      for (const answer of [{ type: "tool_approval" as const }, { type: "tool_denial" as const, message: "No." }]) {
        await dispatchAs(testHost(), other.ws, { ...answer, toolUseId: "google-owner", turnId: frame.turnId, channel: "card" },
          { principal: testPrincipal("penelope"), authorization: testAuthorization("penelope") });
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(decision, "GOOGLE_CARD_OWNER_ONLY_ANSWER").toBeNull();
      expect(host.coordinator.pendingApprovals.size).toBe(1);
      await handleClientMessage(client.ws, { type: "tool_approval", toolUseId: "google-owner", turnId: frame.turnId, channel: "card" });
      await waitFor(() => decision !== null);
      expect(decision as PermissionDecision | null).toEqual({ behavior: "allow" });
      controls[0]!.finish();
    });
  }

  test("Actor always approval reaches its consent service without remembering the generic execution tool", async () => {
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    const { tp, set } = memoryGrants(["Apify Actor run"]);
    setToolPermissionsForTests(tp);
    const { host, client } = await startTurn(controls);
    let decision: PermissionDecision | null = null;
    void controls[0]!.request({ toolName: "Apify Actor run", input: { actor: { id: "SeaCharts01" } }, kind: "actor" }, "actor-once").then(value => { decision = value; });
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    expect(decision, "APIFY_NOT_AUTO_APPROVED_AS_GENERIC_TOOL").toBeNull();
    const frame = client.sent.find(frame => frame.type === "tool_approval_request") as { turnId: string };
    await handleClientMessage(client.ws, { type: "tool_approval", toolUseId: "actor-once", turnId: frame.turnId, always: true, channel: "card" });
    await waitFor(() => decision !== null);
    expect(decision, "APIFY_ALWAYS_CHOICE_REACHES_CONSENT").toMatchObject({ behavior: "allow", always: true });
    expect([...set]).toEqual(["Apify Actor run"]);
    set.delete("Apify Actor run");
    void controls[0]!.request({ toolName: "Apify Actor run", input: { actor: { id: "SirenSong02" } }, kind: "actor" }, "actor-other");
    await waitFor(() => host.coordinator.pendingApprovals.size === 1);
    await handleClientMessage(client.ws, { type: "tool_approval", toolUseId: "actor-other", always: true, channel: "card" });
    expect(set.size, "APIFY_NEVER_REMEMBERS_EXECUTION_TOOL").toBe(0);
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

  test("revoking a Settings grant makes the next real bridge request ask again", async () => {
    const db = getDb();
    setAutoAllowedTools(db, ["web_search"]);
    const { backend, controls } = permissionBackend();
    setBackendForTests(backend);
    setToolPermissionsForTests({
      isAutoAllowed: name => getAutoAllowedTools(db).includes(name),
      add: name => setAutoAllowedTools(db, [...getAutoAllowedTools(db), name]),
    });
    const { host, client } = await startTurn(controls);
    try {
      const first = await controls[0]!.request({ toolName: "web_search", input: {}, kind: "tool" }, "before-revoke");
      expect(first.behavior).toBe("allow");
      expect(host.coordinator.pendingApprovals.size).toBe(0);
      const response = await createToolPermissionRoutes({ db }).request("/tool-permissions/web_search", { method: "DELETE" });
      expect(response.status).toBe(200);
      let nextDecision: PermissionDecision | null = null;
      void controls[0]!.request({ toolName: "web_search", input: {}, kind: "tool" }, "after-revoke").then(decision => { nextDecision = decision; });
      await waitFor(() => nextDecision !== null || client.sent.some(message => message.type === "tool_approval_request"));
      expect(host.coordinator.pendingApprovals.size, "REVOKED_SETTINGS_GRANT_ASKS_AGAIN").toBe(1);
    } finally { controls[0]!.finish(); }
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
