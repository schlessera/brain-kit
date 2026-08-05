import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type {
  AgentBackend,
  FollowUpRequest,
} from "@schlessera/brain-ui-sdk/server";
import {
  handleClientMessage,
  resetForTests,
  isTurnActive,
} from "../src/ws/handler";
import { setBackendForTests } from "../src/agent/backend";
import {
  addClient,
  resetClientsForTests,
  type WSContext,
} from "../src/ws/clients";

// ---------------------------------------------------------------------------
// A controllable fake backend: each turn emits session_info, then hangs until
// the test finishes it (or the host aborts).
// ---------------------------------------------------------------------------

interface TurnControl {
  emit: (m: ServerMessage) => void;
  finish: () => void;
}

function makeFakeBackend(caps: { concurrentSessions: boolean; followUp: boolean }) {
  const controls = new Map<string, TurnControl>();
  const startCalls: Array<{ sessionId: string; isNew: boolean }> = [];
  const followUpCalls: FollowUpRequest[] = [];
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
      concurrentSessions: caps.concurrentSessions,
      followUp: caps.followUp,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn(req) {
      const sessionId = req.sessionId ?? `s${++counter}`;
      startCalls.push({ sessionId, isNew: !req.sessionId });
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId, providerId: "default" });
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      controls.set(sessionId, {
        emit: (m) => req.bridge.emit(m),
        finish: () => {
          req.bridge.emit({ type: "result", sessionId, costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
          resolveDone();
        },
      });
      req.signal.addEventListener(
        "abort",
        () => {
          req.bridge.emit({ type: "status", status: "cancelled", sessionId });
          resolveDone();
        },
        { once: true }
      );
      await done;
    },
    ...(caps.followUp
      ? {
          async followUp(req: FollowUpRequest) {
            followUpCalls.push(req);
          },
        }
      : {}),
    async listSessions() {
      return [];
    },
    async getHistory() {
      return [];
    },
  };

  return { backend, controls, startCalls, followUpCalls };
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

const sid = (f: ServerMessage): string | undefined =>
  (f as { sessionId?: string }).sessionId;

describe("parallel sessions (ws handler)", () => {
  let savedCap: string | undefined;

  beforeEach(() => {
    savedCap = process.env.MAX_CONCURRENT_SESSIONS;
    resetForTests();
    resetClientsForTests();
  });

  afterEach(() => {
    resetForTests();
    resetClientsForTests();
    if (savedCap === undefined) delete process.env.MAX_CONCURRENT_SESSIONS;
    else process.env.MAX_CONCURRENT_SESSIONS = savedCap;
  });

  test("two sessions stream interleaved over one socket, demuxed by sessionId", async () => {
    const { backend, controls } = makeFakeBackend({ concurrentSessions: true, followUp: false });
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    await handleClientMessage(ws, { type: "chat_message", text: "A" });
    await handleClientMessage(ws, { type: "chat_message", text: "B" });
    await waitFor(() => controls.size === 2);

    const [sidA, sidB] = [...controls.keys()];
    controls.get(sidA)!.emit({ type: "text_delta", text: "a1", sessionId: sidA });
    controls.get(sidB)!.emit({ type: "text_delta", text: "b1", sessionId: sidB });
    controls.get(sidA)!.emit({ type: "text_delta", text: "a2", sessionId: sidA });
    controls.get(sidA)!.finish();
    controls.get(sidB)!.finish();
    await waitFor(() => !isTurnActive());

    const aTexts = sent.filter((f) => f.type === "text_delta" && sid(f) === sidA).map((f) => (f as { text: string }).text);
    const bTexts = sent.filter((f) => f.type === "text_delta" && sid(f) === sidB).map((f) => (f as { text: string }).text);
    expect(aTexts).toEqual(["a1", "a2"]);
    expect(bTexts).toEqual(["b1"]);
    expect(sent.filter((f) => f.type === "result").length).toBe(2);
    // Every content frame is scoped.
    for (const f of sent.filter((f) => f.type === "text_delta")) expect(sid(f)).toBeString();
  });

  test("concurrency cap: a start beyond the cap is rejected with SESSION_LIMIT", async () => {
    process.env.MAX_CONCURRENT_SESSIONS = "2";
    const { backend, controls } = makeFakeBackend({ concurrentSessions: true, followUp: false });
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    await handleClientMessage(ws, { type: "chat_message", text: "A" });
    await handleClientMessage(ws, { type: "chat_message", text: "B" });
    await waitFor(() => controls.size === 2);

    await handleClientMessage(ws, { type: "chat_message", text: "C" });
    const limit = sent.find((f) => f.type === "error" && (f as { code: string }).code === "SESSION_LIMIT");
    expect(limit).toBeDefined();
    expect((limit as { message: string }).message).toContain("max 2");
    expect(controls.size).toBe(2); // C never started
  });

  test("follow-up (followUp:false): message to a running session queues then auto-starts", async () => {
    const { backend, controls, startCalls, followUpCalls } = makeFakeBackend({
      concurrentSessions: true,
      followUp: false,
    });
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    await handleClientMessage(ws, { type: "chat_message", text: "first" });
    await waitFor(() => controls.size === 1);
    const sidA = [...controls.keys()][0];

    // A message to the running session is queued (not a new session).
    await handleClientMessage(ws, { type: "chat_message", text: "follow", sessionId: sidA });
    expect(sent.some((f) => f.type === "status" && (f as { status: string }).status === "queued" && sid(f) === sidA)).toBe(true);
    expect(followUpCalls).toHaveLength(0); // no followUp method on this backend

    // Finishing the first turn auto-starts the queued follow-up as the next turn.
    controls.get(sidA)!.finish();
    await waitFor(() => startCalls.filter((c) => c.sessionId === sidA).length === 2);
    expect(startCalls.filter((c) => c.sessionId === sidA)[1].isNew).toBe(false);

    controls.get(sidA)!.finish();
    await waitFor(() => !isTurnActive());
  });

  test("follow-up (followUp:true): calls backend.followUp on the running turn", async () => {
    const { backend, controls, followUpCalls } = makeFakeBackend({
      concurrentSessions: true,
      followUp: true,
    });
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    await handleClientMessage(ws, { type: "chat_message", text: "first" });
    await waitFor(() => controls.size === 1);
    const sidA = [...controls.keys()][0];

    await handleClientMessage(ws, { type: "chat_message", text: "live follow", sessionId: sidA });
    await waitFor(() => followUpCalls.length === 1);
    expect(followUpCalls[0]).toMatchObject({ sessionId: sidA, prompt: "live follow" });
    // No queued status when the backend follows up live.
    expect(sent.some((f) => f.type === "status" && (f as { status: string }).status === "queued")).toBe(false);
  });

  test("cancel with sessionId cancels that session's turn", async () => {
    const { backend, controls } = makeFakeBackend({ concurrentSessions: true, followUp: false });
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    await handleClientMessage(ws, { type: "chat_message", text: "A" });
    await waitFor(() => controls.size === 1);
    const sidA = [...controls.keys()][0];

    await handleClientMessage(ws, { type: "cancel", sessionId: sidA });
    await waitFor(() => !isTurnActive());
    expect(
      sent.some((f) => f.type === "status" && (f as { status: string }).status === "cancelled" && sid(f) === sidA)
    ).toBe(true);
  });

  test("cancel without sessionId while several run → CANCEL_AMBIGUOUS", async () => {
    const { backend, controls } = makeFakeBackend({ concurrentSessions: true, followUp: false });
    setBackendForTests(backend);
    const { ws, sent } = fakeClient();
    addClient(ws);

    await handleClientMessage(ws, { type: "chat_message", text: "A" });
    await handleClientMessage(ws, { type: "chat_message", text: "B" });
    await waitFor(() => controls.size === 2);

    await handleClientMessage(ws, { type: "cancel" });
    expect(sent.some((f) => f.type === "error" && (f as { code: string }).code === "CANCEL_AMBIGUOUS")).toBe(true);
    expect(isTurnActive()).toBe(true); // both still running
  });
});
