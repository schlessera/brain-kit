/**
 * A follow-up sent while its session's turn has not reached the backend yet
 * (#1063). The host registers a resumed turn as running before it awaits
 * billing and the failure-replay snapshot, and only then calls `startTurn`; a
 * queued follow-up turn has the same window after it is dequeued. A backend
 * like the Claude runner has no live turn to inject into in that window, so
 * a message sent there must be queued, never handed to `followUp()` and lost.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { LocalExchange, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { AgentBackend, FollowUpRequest } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "../src/ws/clients";
import {
  addClient,
  closeDb,
  getDb,
  handleClientMessage,
  isTurnActive,
  resetForTests,
  setBackendForTests,
  testHost,
} from "./helpers/test-host";

/**
 * A backend that keeps its own record of live turns, as the Claude runner
 * does: a follow-up for a session with no live turn rejects with the
 * contract's `BackendRequestError`.
 */
function runnerLikeBackend(options: { refuseEveryFollowUp?: boolean; settleLater?: boolean } = {}) {
  /** With `settleLater`, each follow-up's answer waits for the test. */
  const pendingRefusals: Array<() => void> = [];
  const live = new Map<string, { finish: () => void }>();
  const prompts: Array<{ sessionId: string | undefined; prompt: string }> = [];
  const followUps: FollowUpRequest[] = [];
  /** Every follow-up handed over, delivered or refused. */
  const attempts: FollowUpRequest[] = [];
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
      followUp: true,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn(req) {
      const sessionId = req.sessionId ?? "s-ithaca";
      prompts.push({ sessionId: req.sessionId, prompt: req.prompt });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      live.set(sessionId, { finish: resolveDone });
      req.bridge.emit({ type: "session_info", sessionId, isNew: !req.sessionId, providerId: "default" });
      try {
        await done;
        req.bridge.emit({ type: "result", sessionId, costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
      } finally {
        live.delete(sessionId);
      }
    },
    async followUp(req) {
      attempts.push(req);
      if (options.settleLater) await new Promise<void>((resolve) => pendingRefusals.push(resolve));
      if (options.refuseEveryFollowUp || !live.has(req.sessionId)) {
        throw new BackendRequestError(`No running turn for session ${req.sessionId} to deliver a follow-up to.`);
      }
      followUps.push(req);
    },
    async listSessions() { return []; },
    async getHistory() { return []; },
  };
  return { backend, live, prompts, followUps, attempts, pendingRefusals };
}

/** Hold every `failureReplay.begin` until released: the last await before startTurn. */
function holdTurnStarts() {
  const replay = testHost().failureReplay;
  const begin = replay.begin.bind(replay);
  const held: Array<() => void> = [];
  replay.begin = async (...args) => {
    await new Promise<void>((resolve) => held.push(resolve));
    return begin(...args);
  };
  return {
    held,
    releaseNext: () => held.shift()!(),
    restore: () => { replay.begin = begin; for (const resolve of held.splice(0)) resolve(); },
  };
}

function client() {
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send: (data: string) => sent.push(JSON.parse(data) as ServerMessage) };
  addClient(ws);
  return { ws, sent };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

const errors = (sent: ServerMessage[]) =>
  sent.filter((frame): frame is Extract<ServerMessage, { type: "error" }> => frame.type === "error");

const queued = (sent: ServerMessage[], sessionId: string) =>
  sent.filter((frame) =>
    frame.type === "status" && frame.status === "queued" && (frame as { sessionId?: string }).sessionId === sessionId);

const ledger: LocalExchange = {
  id: "x-ledger",
  command: "stats",
  prompt: "Stats",
  answer: [{ kind: "receipt", title: "Crew", rows: [{ k: "ships", v: "12" }] }],
  context: "## Crew\nships: 12",
};

describe("follow-ups sent before the backend has the turn (#1063)", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });

  afterEach(() => {
    resetForTests();
    closeDb();
  });

  test("a resumed turn still starting queues the follow-up, which runs after it", async () => {
    const fake = runnerLikeBackend();
    setBackendForTests(fake.backend);
    const hold = holdTurnStarts();
    const { ws, sent } = client();

    await handleClientMessage(ws, { type: "chat_message", text: "Plot the course past the Sirens", sessionId: "s-ithaca" });
    // Registered as the session's running turn, but not handed to the backend.
    await waitFor(() => hold.held.length === 1 && testHost().coordinator.bySession.has("s-ithaca"));
    expect(fake.live.has("s-ithaca")).toBe(false);

    await handleClientMessage(ws, { type: "chat_message", text: "Wax for the crew's ears", sessionId: "s-ithaca" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors(sent).map((frame) => frame.code)).toEqual([]);
    // Never offered to a backend that has no turn to take it.
    expect(fake.attempts).toEqual([]);
    expect(queued(sent, "s-ithaca")).toHaveLength(1);

    hold.releaseNext();
    await waitFor(() => fake.live.has("s-ithaca"));
    fake.live.get("s-ithaca")!.finish();
    // The queued follow-up is the session's next turn; release its own start.
    await waitFor(() => hold.held.length === 1);
    hold.releaseNext();
    await waitFor(() => fake.prompts.length === 2);
    expect(fake.prompts.map((entry) => entry.prompt)).toEqual([
      "Plot the course past the Sirens",
      "Wax for the crew's ears",
    ]);
    expect(fake.prompts[1]!.sessionId).toBe("s-ithaca");
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => !isTurnActive());
    hold.restore();
  });

  test("a dequeued follow-up turn still starting queues the next one too", async () => {
    const fake = runnerLikeBackend();
    setBackendForTests(fake.backend);
    const { ws, sent } = client();

    await handleClientMessage(ws, { type: "chat_message", text: "Leave Troy", sessionId: "s-ithaca" });
    await waitFor(() => fake.live.has("s-ithaca"));
    // Sent with a thinking level, so it queues behind the running turn.
    await handleClientMessage(ws, { type: "chat_message", text: "Stop at Ismarus", sessionId: "s-ithaca", thinkingLevel: "low" });
    expect(queued(sent, "s-ithaca")).toHaveLength(1);

    const hold = holdTurnStarts();
    fake.live.get("s-ithaca")!.finish();
    // The dequeued turn is waiting before startTurn; the queue is empty again.
    await waitFor(() => hold.held.length === 1);
    expect(fake.live.has("s-ithaca")).toBe(false);

    await handleClientMessage(ws, { type: "chat_message", text: "Count the ships", sessionId: "s-ithaca" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors(sent).map((frame) => frame.code)).toEqual([]);
    expect(fake.attempts).toEqual([]);
    expect(queued(sent, "s-ithaca")).toHaveLength(2);

    hold.restore();
    await waitFor(() => fake.prompts.length === 2);
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => fake.prompts.length === 3);
    expect(fake.prompts.map((entry) => entry.prompt)).toEqual(["Leave Troy", "Stop at Ismarus", "Count the ships"]);
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => !isTurnActive());
  });

  test("a follow-up sent once the backend has the turn is still delivered natively", async () => {
    const fake = runnerLikeBackend();
    setBackendForTests(fake.backend);
    const { ws, sent } = client();

    await handleClientMessage(ws, { type: "chat_message", text: "Sail for Aeolia", sessionId: "s-ithaca" });
    await waitFor(() => fake.live.has("s-ithaca"));
    await handleClientMessage(ws, { type: "chat_message", text: "Keep the bag of winds shut", sessionId: "s-ithaca" });
    await waitFor(() => fake.followUps.length === 1);

    expect(fake.followUps[0]).toMatchObject({ sessionId: "s-ithaca", prompt: "Keep the bag of winds shut" });
    expect(queued(sent, "s-ithaca")).toHaveLength(0);
    expect(errors(sent)).toEqual([]);
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => !isTurnActive());
    expect(fake.prompts).toHaveLength(1);
  });

  test("a follow-up the backend refuses for having no running turn is queued, not lost", async () => {
    const fake = runnerLikeBackend({ refuseEveryFollowUp: true });
    setBackendForTests(fake.backend);
    const { ws, sent } = client();

    await handleClientMessage(ws, { type: "chat_message", text: "Sail for Aeaea", sessionId: "s-ithaca" });
    await waitFor(() => fake.live.has("s-ithaca"));
    // A figure the agent has not seen yet rides on the refused prompt; the
    // queued turn must still carry it.
    await handleClientMessage(ws, { type: "local_exchange", sessionId: "s-ithaca", exchange: ledger });
    await handleClientMessage(ws, { type: "chat_message", text: "Send Eurylochus ahead", sessionId: "s-ithaca" });
    await waitFor(() => queued(sent, "s-ithaca").length + errors(sent).length > 0);

    expect(errors(sent).map((frame) => frame.code)).toEqual([]);
    expect(queued(sent, "s-ithaca")).toHaveLength(1);
    // It was offered and refused: the fallback, not the gate, queued it.
    expect(fake.attempts).toHaveLength(1);
    expect(fake.followUps).toEqual([]);

    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => fake.prompts.length === 2);
    expect(fake.prompts[1]!.sessionId).toBe("s-ithaca");
    expect(fake.prompts[1]!.prompt).toStartWith("Send Eurylochus ahead\n\n<local-answer");
    expect(fake.prompts[1]!.prompt).toContain("ships: 12");
    // Its source was recorded when it was first handed over, and only then:
    // a second row would shift every later identical text in replay.
    const sources = getDb()
      .query("SELECT COUNT(*) AS n FROM message_sources WHERE session_id = ?")
      .get("s-ithaca") as { n: number };
    expect(sources.n).toBe(2);
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => !isTurnActive());
  });

  test("a refused follow-up still runs ahead of messages queued after it", async () => {
    const fake = runnerLikeBackend({ refuseEveryFollowUp: true, settleLater: true });
    setBackendForTests(fake.backend);
    const { ws, sent } = client();

    await handleClientMessage(ws, { type: "chat_message", text: "Sail for Scylla", sessionId: "s-ithaca" });
    await waitFor(() => fake.live.has("s-ithaca"));
    await handleClientMessage(ws, { type: "chat_message", text: "Hug the cliff", sessionId: "s-ithaca" });
    await waitFor(() => fake.pendingRefusals.length === 1);
    // Sent while the first follow-up is still being delivered; it queues.
    await handleClientMessage(ws, { type: "chat_message", text: "Then row hard", sessionId: "s-ithaca", thinkingLevel: "low" });
    expect(queued(sent, "s-ithaca")).toHaveLength(1);
    fake.pendingRefusals.shift()!();
    await waitFor(() => queued(sent, "s-ithaca").length === 2);
    expect(errors(sent)).toEqual([]);

    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => fake.prompts.length === 2);
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => fake.prompts.length === 3);
    expect(fake.prompts.map((entry) => entry.prompt)).toEqual(["Sail for Scylla", "Hug the cliff", "Then row hard"]);
    fake.live.get("s-ithaca")!.finish();
    await waitFor(() => !isTurnActive());
  });
});
