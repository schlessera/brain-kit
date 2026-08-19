/**
 * turnId correlation (protocol rev 2). The host mints a turnId per turn,
 * stamps it on every turn-scoped frame, re-mints it for a queued follow-up,
 * and refuses an inbound reply whose echoed turnId belongs to a different
 * turn.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "../src/ws/clients";
import {
  addClient,
  closeDb,
  handleClientMessage,
  resetForTests,
  setBackendForTests,
} from "./helpers/test-host";

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
