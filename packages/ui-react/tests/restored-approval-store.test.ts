import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage, ServerMessage, SessionRecovery, SessionRecoveryLatest, SessionRecoveryPending } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { pendingApprovals, type ToolCall } from "../src/stores/chat-state.js";
import { trackerViews } from "../src/stores/tracker-state.js";

// A restored approval card follows the host's recovery envelope (#1072,
// D52 §4 R3), in one real root: the chat store, the socket demux and the
// tracker client's own recovery read. The host is a scripted request
// function and scripted frames; Odysseus's voyage supplies the sessions.

const A = "odysseus-sirens";
const B = "odysseus-cyclops";
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const r of roots.splice(0)) r.dispose(); });

function latest(over: Partial<SessionRecoveryLatest>): SessionRecoveryLatest {
  return { requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null, ...over };
}

type Respond = () => Response | Promise<Response>;

function envelope(sessionId: string, over: Partial<SessionRecoveryLatest>, pending: SessionRecoveryPending[] = [], revision = 2): Respond {
  const body: SessionRecovery = { sessionId, backendId: "pi", revision, latest: latest(over), pending };
  return () => Response.json(body);
}

const listed = (toolUseId: string, turnId = "turn-2"): SessionRecoveryPending => ({ kind: "approval", requestId: toolUseId, turnId });

function root(envelopes: Record<string, Respond> = {}) {
  const urls: string[] = [];
  const sent: ClientMessage[] = [];
  const r = createBrainUiRoot({
    storage: null,
    request: async (url) => {
      urls.push(url);
      const match = /\/sessions\/([^/]+)\/recovery$/.exec(url);
      const respond = match ? envelopes[decodeURIComponent(match[1]!)] : undefined;
      return respond ? respond() : Response.json({ error: "not found" }, { status: 404 });
    },
  });
  r.stores.connection.setState({ wsStatus: "connected" });
  const send = r.connection.send;
  r.connection.send = (msg) => { sent.push(msg); return send(msg); };
  roots.push(r);
  return Object.assign(r, { urls, sent });
}

const frame = (r: BrainUiRoot, msg: Record<string, unknown>) => r.connection.handleServerMessage(msg as unknown as ServerMessage);
const hello = (r: BrainUiRoot, recovery = true) =>
  frame(r, { type: "server_hello", protocolRev: 5, principalKey: "pk-ithaca", capabilities: recovery ? { sessionRecovery: true } : {} });
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** A reload of `sessionId`: the replay ends on the user's message, then the host re-delivers its pending approval. */
function restore(r: BrainUiRoot, sessionId: string, toolUseId = "tool-wax", turnId = "turn-2") {
  const chat = r.stores.chat.getState();
  chat.setActiveSession(sessionId);
  frame(r, { type: "session_history", sessionId, messages: [{ role: "user", content: "Row past the Sirens", toolCalls: [] }] });
  frame(r, {
    type: "tool_approval_request", sessionId, turnId, toolUseId, toolName: "Bash",
    input: { command: "seal --ears crew" }, description: "Seal the crew's ears with wax.", kind: "command",
  });
}

function card(r: BrainUiRoot, sessionId: string, name = "Bash"): ToolCall {
  const tool = r.stores.chat.getState().buffers[sessionId]?.messages.flatMap((m) => m.toolCalls).find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name} card in ${sessionId}`);
  return tool;
}

const replies = (r: ReturnType<typeof root>) => r.sent.filter((m) => m.type === "tool_approval" || m.type === "tool_denial");
const awaiting = (r: BrainUiRoot) => pendingApprovals(r.stores.chat.getState()).map((p) => p.tool.id);

describe("a restored approval card, with the host advertising recovery", () => {
  test("stays answerable while the envelope lists it", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]) });
    hello(r);
    restore(r, A);
    await settle();
    expect(r.urls).toContain(`/api/sessions/${A}/recovery`);
    expect(card(r, A).readOnly).toBeUndefined();
    expect(awaiting(r)).toEqual(["tool-wax"]);
  });

  test("absent from pending while its turn still runs: answered on another device, and nothing is sent", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, []) });
    hello(r);
    restore(r, A);
    await settle();
    expect(card(r, A)).toMatchObject({ id: "tool-wax", restored: true, readOnly: "answered" });
    expect(awaiting(r)).toEqual([]);
    expect(replies(r)).toEqual([]);
  });

  test("absent from pending once its turn is terminal, lost, or behind a newer turn: ended with the turn", async () => {
    for (const over of [
      { requestId: "req-2", turnId: "turn-2", state: "terminal" as const, outcome: "success" as const, startedAt: 5, endedAt: 9 },
      { requestId: "req-2", turnId: "turn-2", state: "unknown" as const },
      { requestId: "req-3", turnId: "turn-3", state: "running" as const, startedAt: 11 },
    ]) {
      const r = root({ [A]: envelope(A, over, []) });
      hello(r);
      restore(r, A);
      await settle();
      expect(card(r, A).readOnly).toBe("ended");
      expect(replies(r)).toEqual([]);
    }
  });

  test("absent from pending with a newer request only queued: read-only, and no reason is guessed", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-3", state: "queued" }, []) });
    hello(r);
    restore(r, A);
    await settle();
    expect(card(r, A).readOnly).toBe("unlisted");
    expect(awaiting(r)).toEqual([]);
    // The turn's own result then says which.
    frame(r, { type: "result", sessionId: A, turnId: "turn-2", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(card(r, A).readOnly).toBe("ended");
  });

  test("a tool result while the card waits here is answered on another device", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]) });
    hello(r);
    restore(r, A);
    await settle();
    frame(r, { type: "tool_result", sessionId: A, turnId: "turn-2", toolUseId: "tool-wax", output: "sealed", isError: false });
    expect(card(r, A)).toMatchObject({ status: "complete", readOnly: "answered" });
    expect(replies(r)).toEqual([]);
  });

  test("a decision on this page is not answered elsewhere", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]) });
    hello(r);
    restore(r, A);
    await settle();
    r.stores.chat.getState().resolveToolApproval(A, "tool-wax", true);
    frame(r, { type: "tool_result", sessionId: A, turnId: "turn-2", toolUseId: "tool-wax", output: "sealed", isError: false });
    expect(card(r, A).readOnly).toBeUndefined();
  });

  test("the result of the turn that raised it ends the card; another turn's does not", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]) });
    hello(r);
    restore(r, A);
    await settle();
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(card(r, A).readOnly).toBeUndefined();
    frame(r, { type: "result", sessionId: A, turnId: "turn-2", outcome: "cancelled", durationMs: 0, numTurns: 1, isError: false });
    expect(card(r, A).readOnly).toBe("ended");
    expect(replies(r)).toEqual([]);
  });

  test("a read begun before the card was restored does not close it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Taken before the request was raised: it lists nothing.
    const r = root({ [A]: async () => { await gate; return envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [])(); } });
    hello(r);
    // Session A is tracked: left with a queued request, so a read begins.
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-2" });
    chat.setActiveSession(B);
    expect(r.urls).toEqual([`/api/sessions/${A}/recovery`]);
    restore(r, A, "tool-wax");
    release();
    await settle();
    // The first read proved nothing about the card; the one it asked for next does.
    expect(r.urls.length).toBe(2);
    expect(card(r, A).readOnly).toBe("answered");
  });
});

describe("a closed card and the evidence around it", () => {
  test("a closed card leaves no tracker asking for it, though its frame was held behind the read", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, []) });
    hello(r);
    restore(r, A);
    await settle();
    expect(card(r, A).readOnly).toBe("answered");
    r.stores.chat.getState().setActiveSession(B);
    expect(trackerViews(r.stores.trackers.getState()).find((v) => v.sessionId === A)?.state).not.toBe("needs_you");
  });

  test("a late duplicate of a closed card's request does not revive it", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "terminal", outcome: "success", startedAt: 5, endedAt: 9 }, []) });
    hello(r);
    restore(r, A);
    await settle();
    expect(card(r, A).readOnly).toBe("ended");
    frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-2", toolUseId: "tool-wax", toolName: "Bash", input: { command: "seal --ears crew" }, kind: "command" });
    expect(card(r, A).readOnly).toBe("ended");
    expect(awaiting(r)).toEqual([]);
  });

  test("an envelope rolled back below a revision already seen gives no reason", async () => {
    const responses = [
      envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")], 5),
      envelope(A, { requestId: "req-1", turnId: "turn-1", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 }, [], 3),
    ];
    const r = root({ [A]: () => responses.shift()!() });
    hello(r);
    restore(r, A);
    await settle();
    expect(card(r, A).readOnly).toBeUndefined();
    hello(r);
    await settle();
    expect(responses).toEqual([]);
    expect(card(r, A).readOnly).toBe("unlisted");
  });

  test("a rejected envelope that still lists the card proves nothing; a consistent one listing it makes it answerable again", async () => {
    const responses = [
      envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")], 5),
      envelope(A, { requestId: "req-1", turnId: "turn-1", state: "running", startedAt: 1 }, [listed("tool-wax")], 3),
      envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")], 6),
    ];
    const r = root({ [A]: () => responses.shift()!() });
    hello(r);
    restore(r, A);
    await settle();
    hello(r);
    await settle();
    expect(card(r, A).readOnly).toBe("unlisted");
    expect(awaiting(r)).toEqual([]);
    hello(r);
    await settle();
    expect(responses).toEqual([]);
    expect(card(r, A).readOnly).toBeUndefined();
    expect(awaiting(r)).toEqual(["tool-wax"]);
  });

  test("a late duplicate of a closed card's request starts no tracker", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "terminal", outcome: "success", startedAt: 5, endedAt: 9 }, []) });
    hello(r);
    restore(r, A);
    await settle();
    expect(card(r, A).readOnly).toBe("ended");
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-2", toolUseId: "tool-wax", toolName: "Bash", input: { command: "seal --ears crew" }, kind: "command" });
    expect(trackerViews(r.stores.trackers.getState()).find((v) => v.sessionId === A)?.state).not.toBe("needs_you");
  });
});

describe("a decision on this page while a read is out", () => {
  test("is not overwritten by the read's closure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const r = root({ [A]: async () => { await gate; return envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [])(); } });
    hello(r);
    restore(r, A);
    expect(r.urls).toEqual([`/api/sessions/${A}/recovery`]);
    r.stores.chat.getState().resolveToolApproval(A, "tool-wax", true);
    release();
    await settle();
    expect(card(r, A)).toMatchObject({ status: "approved" });
    expect(card(r, A).readOnly).toBeUndefined();
  });
});

describe("revocation", () => {
  test("a 401 read for one session drops what another session's tracker still lists for its revoked card", async () => {
    const r = root({
      [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]),
      [B]: () => Response.json({ error: "Authentication required", authRequired: true }, { status: 401 }),
    });
    hello(r);
    restore(r, A, "tool-wax", "turn-2");
    await settle();
    // Left with its card waiting: A is tracked, and needs you.
    restore(r, B, "tool-oar", "turn-7");
    expect(trackerViews(r.stores.trackers.getState()).find((v) => v.sessionId === A)?.state).toBe("needs_you");
    await settle();
    expect(card(r, A).readOnly).toBe("revoked");
    expect(trackerViews(r.stores.trackers.getState()).find((v) => v.sessionId === A)?.state).not.toBe("needs_you");
  });

  test("a 401 read makes every restored card no longer yours to answer, and drops its identities", async () => {
    const r = root({
      [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]),
      [B]: () => Response.json({ error: "Authentication required", authRequired: true }, { status: 401 }),
    });
    hello(r);
    restore(r, A, "tool-wax", "turn-2");
    await settle();
    expect(card(r, A).readOnly).toBeUndefined();
    restore(r, B, "tool-oar", "turn-7");
    await settle();
    for (const sessionId of [A, B]) {
      const tool = card(r, sessionId);
      expect(tool.readOnly).toBe("revoked");
      expect(["tool-wax", "tool-oar"]).not.toContain(tool.id);
      expect(tool.approvalTurnId).toBeUndefined();
      const shell = r.stores.chat.getState().buffers[sessionId]!.messages.find((m) => m.turnShell);
      expect(shell?.turnId).toBeUndefined();
    }
    expect(awaiting(r)).toEqual([]);
    expect(replies(r)).toEqual([]);
  });

  test("a revocation makes every restored card no longer yours to answer", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 5 }, [listed("tool-wax")]) });
    hello(r);
    restore(r, A);
    await settle();
    r.stores.trackers.getState().revoke();
    expect(card(r, A).readOnly).toBe("revoked");
    expect(awaiting(r)).toEqual([]);
    expect(replies(r)).toEqual([]);
  });
});

describe("without the capability", () => {
  test("cards behave as after #964: no envelope read, answerable, and a tool result completes them", async () => {
    const r = root({ [A]: envelope(A, { requestId: "req-2", turnId: "turn-2", state: "running" }, []) });
    hello(r, false);
    restore(r, A);
    await settle();
    expect(r.urls.filter((u) => u.includes("/recovery"))).toEqual([]);
    expect(card(r, A)).toMatchObject({ restored: true, status: "pending_approval" });
    expect(card(r, A).readOnly).toBeUndefined();
    expect(awaiting(r)).toEqual(["tool-wax"]);
    r.stores.trackers.getState().revoke();
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(card(r, A).readOnly).toBeUndefined();
    frame(r, { type: "tool_result", sessionId: A, turnId: "turn-2", toolUseId: "tool-wax", output: "sealed", isError: false });
    expect(card(r, A).status).toBe("complete");
    expect(card(r, A).readOnly).toBeUndefined();
  });
});
