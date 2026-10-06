import { afterEach, describe, expect, test } from "bun:test";
import type { ServerMessage, SessionRecovery, SessionRecoveryLatest, SessionRecoveryPending } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot, type BrainUiRootOptions } from "../src/root.js";
import { trackerViews } from "../src/stores/tracker-state.js";
import { TRACKER_STORAGE_KEY, trackerWords } from "../src/lib/trackers.js";
import { observeTrackerSeen } from "../src/hooks/use-tracker-seen.js";

// Trackers in one real root (#948, D52 §4): the chat store, the actual
// socket demux, the recovery read through the root's own request function,
// and its storage. Keyless: the host is a scripted request function and
// scripted frames. Odysseus's voyage supplies the sessions.

const A = "odysseus-sirens";
const B = "odysseus-cyclops";

const roots: BrainUiRoot[] = [];
afterEach(() => { for (const r of roots.splice(0)) r.dispose(); });

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    clear: () => data.clear(), key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); },
  };
}

type Host = {
  envelopes: Map<string, () => Response | Promise<Response>>;
  urls: string[];
};

function latest(over: Partial<SessionRecoveryLatest>): SessionRecoveryLatest {
  return { requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null, ...over };
}

function envelope(sessionId: string, revision: number, over: Partial<SessionRecoveryLatest>, pending: SessionRecoveryPending[] = []): Response {
  const body: SessionRecovery = { sessionId, backendId: "pi", revision, latest: latest(over), pending };
  return Response.json(body);
}

function root(options: BrainUiRootOptions = {}, host: Host = { envelopes: new Map(), urls: [] }) {
  const r = createBrainUiRoot({
    storage: null,
    request: async (url) => {
      host.urls.push(url);
      const match = /\/sessions\/([^/]+)\/recovery$/.exec(url);
      const respond = match ? host.envelopes.get(decodeURIComponent(match[1]!)) : undefined;
      return respond ? respond() : Response.json({ error: "not found" }, { status: 404 });
    },
    ...options,
  });
  r.stores.connection.setState({ wsStatus: "connected" });
  roots.push(r);
  return Object.assign(r, { host });
}

const frame = (r: BrainUiRoot, msg: Record<string, unknown>) => r.connection.handleServerMessage(msg as unknown as ServerMessage);
const hello = (r: BrainUiRoot, recovery = true, principalKey = "pk-ithaca") =>
  frame(r, { type: "server_hello", protocolRev: 5, principalKey, capabilities: recovery ? { sessionRecovery: true } : {} });
const views = (r: BrainUiRoot) => trackerViews(r.stores.trackers.getState(), r.stores.chat.getState().queueNotes);
const ids = (r: BrainUiRoot) => views(r).map((v) => v.sessionId);
const state = (r: BrainUiRoot, sessionId: string) => views(r).find((v) => v.sessionId === sessionId)?.state;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Session A in view and running its turn. */
function runningIn(r: BrainUiRoot, sessionId: string, turnId = "turn-1") {
  const chat = r.stores.chat.getState();
  chat.setActiveSession(sessionId);
  chat.setMessages(sessionId, []);
  chat.addUserMessage(sessionId, "Row past the Sirens");
  frame(r, { type: "session_info", sessionId, isNew: false, turnId });
  frame(r, { type: "text_delta", sessionId, turnId, text: "Wax first." });
  r.connection.flushChatDeltas();
}

describe("creating a tracker", () => {
  test("leaving a running session by selection creates exactly one tracker; leaving an idle one creates none", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    expect(ids(r)).toEqual([A]);
    expect(state(r, A)).toBe("running");
    // Back and away again: still one.
    r.stores.chat.getState().setActiveSession(A);
    r.stores.chat.getState().setActiveSession(B);
    expect(ids(r)).toEqual([A]);
    // B was idle when it was left.
    r.stores.chat.getState().setActiveSession(A);
    expect(ids(r)).toEqual([A]);
  });

  test("New chat from a running session tracks it", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    r.stores.chat.getState().clearMessages();
    expect(ids(r)).toEqual([A]);
  });

  test("leaving the page tracks the session in view, so a reload finds it", () => {
    // The unit runtime has no DOM: a bare event target stands in for the window.
    const page = new EventTarget();
    (globalThis as { window?: unknown }).window = page;
    try {
      const storage = memoryStorage();
      const r = root({ storage, storagePrefix: "ithaca" });
      hello(r, false);
      runningIn(r, A);
      expect(ids(r)).toEqual([]);
      page.dispatchEvent(new Event("pagehide"));
      expect(ids(r)).toEqual([A]);
      expect(r.stores.chat.getState().activeSessionId).toBe(A);
      expect(ids(root({ storage, storagePrefix: "ithaca" }))).toEqual([A]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  test("a pending approval or any of the four questions qualifies a session with no run", () => {
    for (const ask of [
      { type: "tool_approval_request", toolUseId: "tool-wax", toolName: "Bash", input: {} },
      { type: "ask_user_request", requestId: "ask-1", questions: [] },
      { type: "ask_user_list_request", requestId: "ask-1", prompt: "Which oars?", scale: [], items: [], allowSkip: true, notes: false },
      { type: "ask_user_rank_request", requestId: "ask-1", prompt: "Rank the islands", items: [] },
      { type: "ask_user_form_request", requestId: "ask-1", prompt: "Plan the crossing", nodes: [{ id: "course", kind: "single", prompt: "Which course?", options: [{ label: "Coast" }, { label: "Open sea" }] }] },
    ]) {
      const r = root();
      hello(r, false);
      runningIn(r, A);
      frame(r, { ...ask, sessionId: A, turnId: "turn-1" });
      // The turn is idle on the wire, waiting for the reader.
      r.stores.chat.getState().setRunState(A, "idle");
      r.stores.chat.getState().setActiveSession(B);
      expect({ ask: ask.type, ids: ids(r), state: state(r, A) }).toEqual({ ask: ask.type, ids: [A], state: "needs_you" });
    }
  });

  test("work starting in a session not in view tracks it; a late result for an untracked one does not", () => {
    const r = root();
    hello(r, false);
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "result", sessionId: "odysseus-aeolus", turnId: "turn-9", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    expect(ids(r)).toEqual([]);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-1" });
    expect(ids(r)).toEqual([A]);
    expect(state(r, A)).toBe("queued");
    // Frames for the session in view never track it.
    frame(r, { type: "session_info", sessionId: B, isNew: false, turnId: "turn-b" });
    expect(ids(r)).toEqual([A]);
  });

  test("a draft whose session is named after the reader left becomes one tracker, owned by that session", () => {
    const r = root();
    hello(r, false);
    const chat = r.stores.chat.getState();
    const draftId = chat.startDraftTurn();
    chat.addUserMessage(null, "Chart the way home");
    chat.startAssistantMessage(null);
    // New chat before the host named the session, then a second draft.
    chat.clearMessages();
    const second = r.stores.chat.getState().startDraftTurn();
    r.stores.chat.getState().addUserMessage(null, "Count the cattle of the Sun");
    frame(r, { type: "session_info", sessionId: A, isNew: true, draftId, turnId: "turn-1" });
    frame(r, { type: "text_delta", sessionId: A, turnId: "turn-1", text: "West, then north." });
    frame(r, { type: "session_info", sessionId: A, isNew: true, draftId, turnId: "turn-1" });
    expect(ids(r)).toEqual([A]);
    // The second draft was not adopted by the first one's session.
    expect(r.stores.chat.getState().pendingDraftId).toBe(second);
    expect(r.stores.chat.getState().activeSessionId).toBeNull();
    // A draft named while it is still in view is watched: no tracker.
    frame(r, { type: "session_info", sessionId: B, isNew: true, draftId: second, turnId: "turn-b" });
    expect(r.stores.chat.getState().activeSessionId).toBe(B);
    expect(ids(r)).toEqual([A]);
  });

  test("late frames for a left session move its tracker, not the view", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "error", durationMs: 1, numTurns: 1, isError: true });
    expect(state(r, A)).toBe("failed");
    expect(r.stores.chat.getState().activeSessionId).toBe(B);
  });

  test("a send the host never acknowledged is unconfirmed until it is accepted", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.setMessages(A, []);
    chat.addUserMessage(A, "Bind me to the mast", "typed", undefined, { requestId: "req-mast" });
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("unconfirmed");
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-mast" });
    expect(state(r, A)).toBe("queued");
  });

  test("a refused send stays refused after the composer consumes its receipt: no phantom tracker", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.setMessages(A, []);
    chat.addUserMessage(A, "Open the bag of winds", "typed", undefined, { requestId: "req-winds" });
    frame(r, { type: "error", sessionId: A, code: "SESSION_LIMIT", message: "Too many concurrent sessions (max 2).", requestId: "req-winds" });
    r.stores.chat.getState().clearChatReceipt("req-winds");
    r.stores.chat.getState().setActiveSession(B);
    expect(ids(r)).toEqual([]);
  });

  test("a follow-up waiting as a local entry is the send that is unconfirmed", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    runningIn(r, A);
    r.stores.chat.getState().addUserMessage(A, "Row past the Sirens", "typed", undefined, { requestId: "req-1" });
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1", requestId: "req-1" });
    r.stores.followUp.getState().addLocal(A, { requestId: "req-2", text: "And the cattle of the Sun?", source: "typed", queuedAt: 1 });
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("unconfirmed");
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-2" });
    expect(state(r, A)).toBe("queued");
  });

  test("acceptance is remembered after newer work moves on and after a queue report", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    runningIn(r, A);
    r.stores.chat.getState().addUserMessage(A, "Row past the Sirens", "typed", undefined, { requestId: "req-1" });
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1", requestId: "req-1" });
    r.stores.chat.getState().clearChatReceipt("req-1");
    // Another device's request is now the latest work.
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-other-device" });
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("queued");
    // A follow-up the host reports holding was accepted too.
    r.stores.followUp.getState().addLocal(B, { requestId: "req-b", text: "Who keeps watch?", source: "typed", queuedAt: 1 });
    frame(r, { type: "session_queue", sessionId: B, followUps: [{ id: "q-1", requestId: "req-b", text: "Who keeps watch?", queuedAt: 1 }] });
    expect(r.stores.trackers.getState().acceptedRequests).toContain("req-b");
  });

  test("an answered question no longer needs you, even before its tool result", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    frame(r, { type: "ask_user_request", sessionId: A, turnId: "turn-1", requestId: "ask-1", questions: [] });
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("needs_you");
    frame(r, { type: "ask_answer_receipt", sessionId: A, turnId: "turn-1", requestId: "ask-1", submissionId: "sub-1", state: "accepted" });
    expect(state(r, A)).toBe("running");
  });

  test("an approval decided on its card no longer needs you while its tool runs; a replayed call does not count", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-1", toolUseId: "tool-wax", toolName: "Bash", input: {} });
    r.stores.chat.getState().setActiveSession(B);
    r.stores.chat.getState().setActiveSession(A);
    expect(state(r, A)).toBe("needs_you");
    // A replay rebuilds the call as complete before the re-delivery: still pending.
    const replayed = { id: "hist-1", role: "assistant" as const, content: "", parts: [], isStreaming: false, timestamp: 1, toolCalls: [{ id: "tool-wax", name: "Bash", input: {}, inputJson: "{}", status: "complete" as const }] };
    r.stores.chat.getState().setMessages(A, [replayed]);
    expect(state(r, A)).toBe("needs_you");
    frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-1", toolUseId: "tool-wax", toolName: "Bash", input: {} });
    r.stores.chat.getState().resolveToolApproval(A, "tool-wax", true);
    expect(state(r, A)).toBe("running");
  });

  test("a queue report for a session not in view is work: it is tracked and read", async () => {
    const host: Host = { envelopes: new Map([[A, () => envelope(A, 4, { requestId: "req-4", state: "queued" }, [])]]), urls: [] };
    const r = root({}, host);
    hello(r);
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "session_queue", sessionId: A, followUps: [{ id: "q-4", requestId: "req-4", text: "Who keeps watch?", queuedAt: 1 }] });
    expect(state(r, A)).toBe("queued");
    await settle();
    expect(host.urls).toEqual([`/api/sessions/${A}/recovery`]);
    // An empty report is not work.
    frame(r, { type: "session_queue", sessionId: "odysseus-aeolus", followUps: [] });
    expect(ids(r)).toEqual([A]);
  });

  test("a refused answer leaves the question waiting", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    frame(r, { type: "ask_user_request", sessionId: A, turnId: "turn-1", requestId: "ask-1", questions: [] });
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "ask_answer_receipt", sessionId: A, turnId: "turn-1", requestId: "ask-1", submissionId: "sub-1", state: "closed", reason: "refused" });
    expect(state(r, A)).toBe("needs_you");
  });

  test("opening a tracked session reads it again", async () => {
    const host: Host = { envelopes: new Map([[A, () => envelope(A, 2, { requestId: "req-1", turnId: "turn-1", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 })]]), urls: [] };
    const r = root({}, host);
    hello(r);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    await settle();
    host.urls.length = 0;
    r.stores.chat.getState().setActiveSession(A);
    await settle();
    expect(host.urls).toEqual([`/api/sessions/${A}/recovery`]);
  });

  test("a tracker created only for a send the host then refuses goes away", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.setMessages(A, []);
    chat.addUserMessage(A, "Open the bag of winds", "typed", undefined, { requestId: "req-winds" });
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("unconfirmed");
    frame(r, { type: "error", sessionId: A, code: "SESSION_QUEUE_FULL", message: "This session's queue is full.", requestId: "req-winds" });
    expect(ids(r)).toEqual([]);
  });

  test("the composer's optimistic bubble is not accepted work, even across a second leave", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.setMessages(A, []);
    chat.addUserMessage(A, "Open the bag of winds", "typed", undefined, { requestId: "req-winds" });
    // What the composer does at send, before the host has answered.
    r.stores.chat.getState().startAssistantMessage(A, undefined, "req-winds");
    r.stores.chat.getState().setActiveSession(B);
    r.stores.chat.getState().setActiveSession(A);
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("unconfirmed");
    frame(r, { type: "error", sessionId: A, code: "SESSION_LIMIT", message: "Too many concurrent sessions (max 2).", requestId: "req-winds" });
    expect(ids(r)).toEqual([]);
  });

  test("a refusal keeps a tracker that also has accepted work", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    runningIn(r, A);
    r.stores.chat.getState().addUserMessage(A, "Open the bag of winds", "typed", undefined, { requestId: "req-winds" });
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "error", sessionId: A, code: "SESSION_QUEUE_FULL", message: "This session's queue is full.", requestId: "req-winds" });
    expect(views(r).map((v) => [v.sessionId, v.state])).toEqual([[A, "running"]]);
  });

  test("while a newer send is unconfirmed, the older turn on screen does not clear the tracker", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    runningIn(r, A);
    r.stores.followUp.getState().addLocal(A, { requestId: "req-2", text: "And the cattle of the Sun?", source: "typed", queuedAt: 1 });
    r.stores.chat.getState().setActiveSession(B);
    r.stores.chat.getState().setActiveSession(A);
    expect(r.stores.trackers.getState().observeSeen({ sessionId: A, turnId: "turn-1", revision: 0 })).toBe(false);
    expect(views(r)[0]).toMatchObject({ state: "unconfirmed", cleared: false });
  });

  test("work starting in the session in view while the document is hidden is unwatched", () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    (globalThis as { document?: unknown }).document = doc;
    try {
      const r = root();
      hello(r, false);
      r.stores.chat.getState().setActiveSession(A);
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(ids(r)).toEqual([]);
      frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1", requestId: "req-other-device" });
      expect(views(r).map((v) => [v.sessionId, v.state])).toEqual([[A, "running"]]);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  test("an accepted send stays accepted after the composer consumes its receipt", () => {
    const r = root();
    hello(r, false);
    r.stores.connection.getState().setChatRequestAck(true);
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.setMessages(A, []);
    chat.addUserMessage(A, "Bind me to the mast", "typed", undefined, { requestId: "req-mast" });
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1", requestId: "req-mast" });
    expect(r.stores.chat.getState().chatReceipts["req-mast"]).toBeDefined();
    // What the composer does once it has cleared its input.
    r.stores.chat.getState().clearChatReceipt("req-mast");
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("running");
  });
});

describe("clearing a tracker", () => {
  function seenFixture() {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    return r;
  }

  test("selecting the session acknowledges nothing", () => {
    const r = seenFixture();
    r.stores.chat.getState().setActiveSession(A);
    expect(views(r).map((v) => [v.sessionId, v.state, v.cleared])).toEqual([[A, "done", false]]);
    // Left again while merely selected: it stays.
    r.stores.chat.getState().setActiveSession(B);
    expect(views(r).map((v) => [v.sessionId, v.cleared])).toEqual([[A, false]]);
  });

  test("only the latest turn's key clears it; an older observation cannot erase newer work", () => {
    const r = seenFixture();
    const trackers = r.stores.trackers.getState();
    // A newer turn starts before an old viewport observation lands.
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-2", requestId: "req-2" });
    expect(trackers.observeSeen({ sessionId: A, turnId: "turn-1", revision: 0 })).toBe(false);
    expect(views(r)[0]).toMatchObject({ state: "running", cleared: false });
    expect(r.stores.trackers.getState().observeSeen({ sessionId: A, turnId: "turn-2", revision: 0 })).toBe(true);
    expect(views(r)[0]).toMatchObject({ cleared: true });
    expect(r.stores.trackers.getState().records[A]!.seen).toEqual({ turnId: "turn-2", revision: 0, basis: "proof" });
    // Seen and left idle: the tracker goes.
    r.stores.chat.getState().setActiveSession(A);
    r.stores.chat.getState().setRunState(A, "idle");
    frame(r, { type: "result", sessionId: A, turnId: "turn-2", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    r.stores.chat.getState().setActiveSession(B);
    expect(ids(r)).toEqual([]);
  });

  test("Mark as seen stores an acknowledgement, never proof", () => {
    const r = seenFixture();
    r.stores.trackers.getState().acknowledge(A);
    expect(r.stores.trackers.getState().records[A]!.seen).toEqual({ turnId: "turn-1", revision: 0, basis: "acknowledged" });
    expect(views(r)[0]!.cleared).toBe(true);
  });
});

describe("the seen observer's conditions", () => {
  test("only Chat, visible, uncovered and at the end of the linked turn sees it", () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    (globalThis as { document?: unknown }).document = doc;
    try {
      const r = root();
      hello(r, false);
      runningIn(r, A);
      r.stores.chat.getState().setActiveSession(B);
      frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      r.stores.chat.getState().setActiveSession(A);
      const bottom = { clientHeight: 400, scrollHeight: 1000, scrollTop: 600 } as HTMLElement;
      const up = { clientHeight: 400, scrollHeight: 1000, scrollTop: 100 } as HTMLElement;
      const ui = r.stores.ui;
      const blocked: Array<[string, () => void, () => void]> = [
        ["scrolled up", () => {}, () => {}],
        ["hidden document", () => { doc.visibilityState = "hidden"; }, () => { doc.visibilityState = "visible"; }],
        ["session panel", () => ui.setState({ sessionPanelOpen: true }), () => ui.setState({ sessionPanelOpen: false })],
        ["files panel", () => ui.setState({ filePanelOpen: true }), () => ui.setState({ filePanelOpen: false })],
        ["command palette", () => ui.setState({ paletteOpen: true }), () => ui.setState({ paletteOpen: false })],
        ["another view", () => ui.setState({ activeView: "activity" }), () => ui.setState({ activeView: "chat" })],
        ["subagent drill-in", () => ui.setState({ subagentStack: ["span-1"] }), () => ui.setState({ subagentStack: [] })],
        ["mask editor", () => r.stores.mask.setState({ request: { requestId: "m1" } as never }), () => r.stores.mask.setState({ request: null })],
        ["handoff sheet", () => r.stores.handoff.setState({ sheet: { kind: "review" } as never }), () => r.stores.handoff.setState({ sheet: null })],
      ];
      for (const [name, cover, uncover] of blocked) {
        cover();
        const seen = observeTrackerSeen(r, name === "scrolled up" ? up : bottom, false);
        uncover();
        expect({ name, seen }).toEqual({ name, seen: false });
      }
      expect(observeTrackerSeen(r, bottom, true)).toBe(false);
      expect(views(r)[0]!.cleared).toBe(false);
      expect(observeTrackerSeen(r, bottom, false)).toBe(true);
      expect(views(r)[0]!.cleared).toBe(true);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("persistence", () => {
  function tracked(storage: Storage, storagePrefix: string, sessionId = A) {
    const r = root({ storage, storagePrefix });
    hello(r, false);
    runningIn(r, sessionId);
    r.stores.chat.getState().setActiveSession(B);
    return r;
  }

  test("a fresh root with the same prefix restores the trackers; another prefix sees none of them", () => {
    const storage = memoryStorage();
    tracked(storage, "ithaca");
    const restored = root({ storage, storagePrefix: "ithaca" });
    expect(ids(restored)).toEqual([A]);
    const other = root({ storage, storagePrefix: "troy" });
    expect(ids(other)).toEqual([]);
    // Another root's changes never erase this one's.
    tracked(storage, "troy", "odysseus-aeolus");
    other.stores.trackers.getState().revoke();
    expect(ids(root({ storage, storagePrefix: "ithaca" }))).toEqual([A]);
  });

  test("two tabs of one root keep each other's trackers, and a removal in one is a removal", () => {
    const storage = memoryStorage();
    const first = root({ storage, storagePrefix: "ithaca" });
    const second = root({ storage, storagePrefix: "ithaca" });
    hello(first, false); hello(second, false);
    runningIn(first, A);
    first.stores.chat.getState().setActiveSession("odysseus-aeolus");
    runningIn(second, B);
    second.stores.chat.getState().setActiveSession("odysseus-aeolus");
    // The second tab started before the first stored A; writing B keeps A.
    const stored = () => Object.keys(JSON.parse(storage.data.get(`ithaca:${TRACKER_STORAGE_KEY}`) ?? '{"trackers":[]}').trackers.reduce((m: Record<string, true>, t: { sessionId: string }) => ({ ...m, [t.sessionId]: true }), {})).sort();
    expect(stored()).toEqual([B, A].sort());
    // The first tab hears of B through a storage event.
    first.stores.trackers.getState().syncFromStorage();
    expect(ids(first).sort()).toEqual([A, B].sort());
    // A seen and left idle in the second tab is removed from the stored set;
    // the first tab's next write does not bring it back.
    second.stores.trackers.getState().syncFromStorage();
    second.stores.trackers.getState().acknowledge(A);
    second.stores.trackers.getState().leftIdle(A);
    expect(second.stores.trackers.getState().records[A]).toBeUndefined();
    first.stores.trackers.getState().syncFromStorage();
    first.stores.trackers.getState().track("odysseus-circe");
    expect(stored()).toEqual([B, "odysseus-circe"].sort());
  });

  test("a tracker another tab stored, or stored at a newer revision, starts over here and is read again", async () => {
    const storage = memoryStorage();
    const host: Host = { envelopes: new Map([[A, () => envelope(A, 2, { requestId: "req-2", turnId: "turn-2", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 })]]), urls: [] };
    const here = root({ storage, storagePrefix: "ithaca" }, host);
    hello(here);
    // This tab knows A at revision 1, turn 1, as done.
    here.stores.trackers.getState().track(A);
    here.stores.trackers.getState().beginRead(A);
    here.stores.trackers.getState().endRead(A, { ok: true, recovery: { sessionId: A, backendId: null, revision: 1, latest: latest({ requestId: "req-1", turnId: "turn-1", state: "terminal", outcome: "success" }), pending: [] } }, here.stores.trackers.getState().epoch);
    // The other tab stored A at revision 2.
    const key = `ithaca:${TRACKER_STORAGE_KEY}`;
    storage.setItem(key, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [{ sessionId: A, requestId: "req-2", turnId: "turn-2", revision: 2, leftAt: 5, seen: null }] }));
    host.urls.length = 0;
    expect(here.stores.trackers.getState().syncFromStorage()).toEqual([A]);
    // Turn 1 can no longer be seen as the latest.
    expect(here.stores.trackers.getState().observeSeen({ sessionId: A, turnId: "turn-1", revision: 1 })).toBe(false);
    expect(views(here)[0]).toMatchObject({ revision: 2 });
  });

  test("a stored turn that moved at the same revision starts over here, and this tab's writes never restore an older record", () => {
    const storage = memoryStorage();
    const k = `ithaca:${TRACKER_STORAGE_KEY}`;
    const here = root({ storage, storagePrefix: "ithaca" });
    hello(here, false);
    runningIn(here, A, "turn-1");
    here.stores.chat.getState().setActiveSession(B);
    frame(here, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    // Another tab saw turn 2 start live, at the same (unknown) revision.
    const theirs = { sessionId: A, requestId: "req-2", turnId: "turn-2", revision: null, leftAt: 9, seen: null };
    storage.setItem(k, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [theirs] }));
    expect(here.stores.trackers.getState().syncFromStorage(k)).toEqual([A]);
    expect(here.stores.trackers.getState().observeSeen({ sessionId: A, turnId: "turn-1", revision: 0 })).toBe(false);
    // Another tab stores A at revision 5; this tab then tracks something else.
    storage.setItem(k, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [{ ...theirs, revision: 5 }] }));
    here.stores.trackers.getState().track("odysseus-circe");
    const stored = JSON.parse(storage.data.get(k)!).trackers.find((t: { sessionId: string }) => t.sessionId === A);
    expect(stored).toMatchObject({ revision: 5, turnId: "turn-2" });
  });

  test("a tab that has not heard of another tab's newer turn cannot overwrite or remove it", () => {
    const storage = memoryStorage();
    const k = `ithaca:${TRACKER_STORAGE_KEY}`;
    const here = root({ storage, storagePrefix: "ithaca" });
    hello(here, false);
    runningIn(here, A, "turn-1");
    here.stores.chat.getState().setActiveSession(B);
    frame(here, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    const mine = here.stores.trackers.getState().records[A]!;
    // Another tab stores turn 2 at the same revision; this tab has not synced.
    const theirs = { ...mine, requestId: "req-2", turnId: "turn-2", leftAt: mine.leftAt + 1 };
    storage.setItem(k, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [theirs] }));
    const stored = () => JSON.parse(storage.data.get(k) ?? '{"trackers":[]}').trackers.find((t: { sessionId: string }) => t.sessionId === A);
    // An observation of turn 1 here.
    expect(here.stores.trackers.getState().observeSeen({ sessionId: A, turnId: "turn-1", revision: 0 })).toBe(true);
    expect(stored()).toMatchObject({ turnId: "turn-2", seen: null });
  });

  test("a tab removing a tracker it saw leaves another tab's newer turn stored", () => {
    const storage = memoryStorage();
    const k = `ithaca:${TRACKER_STORAGE_KEY}`;
    const here = root({ storage, storagePrefix: "ithaca" });
    hello(here, false);
    runningIn(here, A, "turn-1");
    here.stores.chat.getState().setActiveSession(B);
    frame(here, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    expect(here.stores.trackers.getState().observeSeen({ sessionId: A, turnId: "turn-1", revision: 0 })).toBe(true);
    const mine = here.stores.trackers.getState().records[A]!;
    storage.setItem(k, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [{ ...mine, requestId: "req-2", turnId: "turn-2", seen: null }] }));
    here.stores.trackers.getState().leftIdle(A);
    const stored = JSON.parse(storage.data.get(k) ?? '{"trackers":[]}').trackers;
    expect(stored).toMatchObject([{ sessionId: A, turnId: "turn-2", seen: null }]);
  });

  test("a tracker taken in while this tab writes is read too", async () => {
    const storage = memoryStorage();
    const k = `ithaca:${TRACKER_STORAGE_KEY}`;
    const host: Host = { envelopes: new Map([["odysseus-circe", () => envelope("odysseus-circe", 1, { requestId: "req-c", turnId: "turn-c", state: "running", startedAt: 1 })]]), urls: [] };
    const here = root({ storage, storagePrefix: "ithaca" }, host);
    hello(here);
    storage.setItem(k, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [{ sessionId: "odysseus-circe", requestId: "req-c", turnId: "turn-c", revision: 1, leftAt: 5, seen: null }] }));
    // Before any storage event, this tab writes its own tracker.
    here.stores.trackers.getState().track(A);
    await settle();
    expect(host.urls).toContain("/api/sessions/odysseus-circe/recovery");
    expect(views(here).find((v) => v.sessionId === "odysseus-circe")).toMatchObject({ state: "running", settled: true });
  });

  test("a stale tab never overwrites a set another tab stored for a different principal", () => {
    const storage = memoryStorage();
    const k = `ithaca:${TRACKER_STORAGE_KEY}`;
    const stale = root({ storage, storagePrefix: "ithaca" });
    hello(stale, false, "pk-ithaca");
    runningIn(stale, A);
    stale.stores.chat.getState().setActiveSession(B);
    const theirs = JSON.stringify({ v: 1, principalKey: "pk-penelope", trackers: [{ sessionId: "odysseus-loom", requestId: null, turnId: null, revision: null, leftAt: 1, seen: null }] });
    storage.setItem(k, theirs);
    stale.stores.trackers.getState().track("odysseus-circe");
    expect(storage.data.get(k)).toBe(theirs);
  });

  test("a storage event for another key, or a root that keeps nothing, changes nothing", () => {
    const memory = root({ storage: null });
    hello(memory, false);
    runningIn(memory, A);
    memory.stores.chat.getState().setActiveSession(B);
    expect(memory.stores.trackers.getState().syncFromStorage(null)).toEqual([]);
    expect(ids(memory)).toEqual([A]);
    const storage = memoryStorage();
    const kept = root({ storage, storagePrefix: "ithaca" });
    hello(kept, false);
    runningIn(kept, A);
    kept.stores.chat.getState().setActiveSession(B);
    storage.removeItem(`ithaca:${TRACKER_STORAGE_KEY}`);
    expect(kept.stores.trackers.getState().syncFromStorage("ithaca:brain-theme")).toEqual([]);
    expect(ids(kept)).toEqual([A]);
  });

  test("a storage event from another tab reads the trackers it brought", async () => {
    const page = new EventTarget();
    (globalThis as { window?: unknown }).window = page;
    try {
      const storage = memoryStorage();
      const host: Host = { envelopes: new Map([[A, () => envelope(A, 2, { requestId: "req-2", turnId: "turn-2", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 })]]), urls: [] };
      const here = root({ storage, storagePrefix: "ithaca" }, host);
      hello(here);
      storage.setItem(`ithaca:${TRACKER_STORAGE_KEY}`, JSON.stringify({ v: 1, principalKey: "pk-ithaca", trackers: [{ sessionId: A, requestId: "req-2", turnId: "turn-2", revision: 2, leftAt: 5, seen: null }] }));
      page.dispatchEvent(new Event("storage"));
      await settle();
      expect(host.urls).toEqual([`/api/sessions/${A}/recovery`]);
      expect(views(here)[0]).toMatchObject({ state: "done", settled: true });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  test("restored trackers keep identifiers only, not transcripts or payloads", () => {
    const storage = memoryStorage();
    tracked(storage, "ithaca");
    const raw = storage.data.get(`ithaca:${TRACKER_STORAGE_KEY}`)!;
    expect(raw).not.toContain("Row past the Sirens");
    expect(raw).not.toContain("Wax first.");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, principalKey: "pk-ithaca", trackers: [{ sessionId: A, turnId: "turn-1" }] });
  });

  test("disabled, missing, throwing and malformed storage never throw and restore nothing", () => {
    // Throwing for the tracker key only: the other stores are not under test.
    const base = memoryStorage();
    const mine = (key: string) => key.endsWith(TRACKER_STORAGE_KEY);
    const throwing = {
      ...base,
      getItem: (key: string) => { if (mine(key)) throw new Error("denied"); return base.getItem(key); },
      setItem: (key: string, value: string) => { if (mine(key)) throw new Error("full"); base.setItem(key, value); },
      removeItem: (key: string) => { if (mine(key)) throw new Error("denied"); base.removeItem(key); },
    } as Storage;
    expect(() => tracked(throwing, "ithaca")).not.toThrow();
    expect(ids(root({ storage: throwing, storagePrefix: "ithaca" }))).toEqual([]);
    const none = root({ storage: null, storagePrefix: "ithaca" });
    expect(ids(none)).toEqual([]);
    for (const raw of ["{", "[]", JSON.stringify({ v: 2, trackers: [] }), JSON.stringify({ v: 1, trackers: [{ sessionId: "" }] })]) {
      const storage = memoryStorage();
      storage.setItem(`ithaca:${TRACKER_STORAGE_KEY}`, raw);
      expect(ids(root({ storage, storagePrefix: "ithaca" }))).toEqual([]);
    }
  });

  test("a different principal deletes the set; the same one keeps it", () => {
    const storage = memoryStorage();
    tracked(storage, "ithaca");
    const same = root({ storage, storagePrefix: "ithaca" });
    hello(same, false, "pk-ithaca");
    expect(ids(same)).toEqual([A]);
    const other = root({ storage, storagePrefix: "ithaca" });
    hello(other, false, "pk-polyphemus");
    expect(ids(other)).toEqual([]);
    expect(ids(root({ storage, storagePrefix: "ithaca" }))).toEqual([]);
  });

  test("more than eight buffers: eviction keeps every tracker and never changes the session in view", () => {
    const r = root();
    hello(r, false);
    const sessions = Array.from({ length: 11 }, (_, i) => `odysseus-island-${i}`);
    for (const sessionId of sessions) {
      runningIn(r, sessionId, `turn-${sessionId}`);
      r.stores.chat.getState().setActiveSession(B);
      // Finished in the background, so its buffer may be evicted.
      frame(r, { type: "result", sessionId, turnId: `turn-${sessionId}`, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    }
    r.stores.chat.getState().setActiveSession(A);
    expect(Object.keys(r.stores.chat.getState().buffers).length).toBeLessThanOrEqual(9);
    expect(ids(r).sort()).toEqual([...sessions].sort());
    expect(r.stores.chat.getState().activeSessionId).toBe(A);
  });
});

describe("recovery (Recovery A)", () => {
  test("a cold root reads each tracker's envelope only when the host advertises it, and never sends anything", async () => {
    const storage = memoryStorage();
    const first = root({ storage, storagePrefix: "ithaca" });
    hello(first, false);
    runningIn(first, A);
    first.stores.chat.getState().setActiveSession(B);
    expect(first.host.urls.filter((u) => u.includes("/recovery"))).toEqual([]);

    const host: Host = { envelopes: new Map([[A, () => envelope(A, 3, { requestId: "req-1", turnId: "turn-1", state: "terminal", outcome: "success", startedAt: 10, endedAt: 20 })]]), urls: [] };
    const cold = root({ storage, storagePrefix: "ithaca" }, host);
    const sent: unknown[] = [];
    const send = cold.connection.send;
    cold.connection.send = (msg) => { sent.push(msg); return send(msg); };
    expect(state(cold, A)).toBe("cant_check");
    hello(cold);
    await settle();
    expect(host.urls).toEqual([`/api/sessions/${A}/recovery`]);
    expect(views(cold)[0]).toMatchObject({ sessionId: A, state: "done", startedAt: 10, endedAt: 20, revision: 3 });
    expect(sent).toEqual([]);
    expect(cold.stores.chat.getState().activeSessionId).toBe(B);
  });

  test("after a reload, an envelope at the stored revision naming older work than the stored request is a rollback", async () => {
    const storage = memoryStorage();
    const key = `ithaca:${TRACKER_STORAGE_KEY}`;
    // Revision 3 was read, then request 4 was accepted live.
    storage.setItem(key, JSON.stringify({ v: 1, principalKey: null, trackers: [{ sessionId: A, requestId: "req-4", turnId: null, revision: 3, leftAt: 1, seen: null }] }));
    const host: Host = { envelopes: new Map([[A, () => envelope(A, 3, { requestId: "req-3", turnId: "turn-3", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 })]]), urls: [] };
    const r = root({ storage, storagePrefix: "ithaca" }, host);
    hello(r);
    await settle();
    expect(state(r, A)).toBe("unknown");
  });

  test("a held acceptance the envelope does not name is not assumed newer: the envelope stands and is read again", async () => {
    let release!: () => void;
    let reads = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host: Host = { envelopes: new Map([[A, async () => { reads++; if (reads === 1) await gate; return envelope(A, 3, { requestId: "req-3", state: "queued" }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-1" });
    // The read is in flight; an acceptance the envelope will not name arrives.
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-2" });
    release();
    await settle(); await settle();
    expect(r.stores.trackers.getState().evidence[A]!.latest).toMatchObject({ requestId: "req-3", state: "queued" });
    expect(reads).toBe(2);
    // req-3's dispatch is recognised.
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-3", requestId: "req-3" });
    expect(state(r, A)).toBe("running");
  });

  test("a held turn other than the envelope's is not assumed newer either", async () => {
    let release!: () => void;
    let reads = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host: Host = { envelopes: new Map([[A, async () => { reads++; if (reads === 1) await gate; return envelope(A, 2, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 1 }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-2" });
    // A reconnect announces turn 1, naming no request, during the read.
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1" });
    release();
    await settle(); await settle();
    expect(r.stores.trackers.getState().evidence[A]!.latest).toMatchObject({ turnId: "turn-2", state: "running" });
    expect(reads).toBe(2);
  });

  test("a turnless error for a request this page never saw accepted still asks the host", async () => {
    let reads = 0;
    // First the session's earlier turn, running; then the new request, unknown.
    const host: Host = { envelopes: new Map([[A, () => { reads++; return reads === 1 ? envelope(A, 1, { requestId: "req-1", turnId: "turn-1", state: "running", startedAt: 1 }) : envelope(A, 2, { requestId: "req-x", state: "unknown" }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    await settle();
    const before = reads;
    frame(r, { type: "error", sessionId: A, code: "BACKEND_ERROR", message: "No backend.", requestId: "req-x" });
    await settle();
    expect(reads).toBe(before + 1);
    expect(state(r, A)).toBe("unknown");
  });

  test("a held turn's end still settles what it raised, even when its order waits for the reread", async () => {
    let release!: () => void;
    let reads = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host: Host = { envelopes: new Map([[A, async () => { reads++; if (reads === 1) await gate; if (reads === 2) return Response.json({}, { status: 500 }); return envelope(A, 2, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 1 }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-2" });
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1" });
    frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-1", toolUseId: "tool-wax", toolName: "Bash", input: {} });
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    release();
    await settle(); await settle();
    expect(r.stores.trackers.getState().evidence[A]!.pending).toEqual([]);
  });

  test("held progress after an ambiguous dispatch waits for the reread with it", async () => {
    let release!: () => void;
    let reads = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host: Host = { envelopes: new Map([[A, async () => { reads++; if (reads === 1) await gate; return envelope(A, 3, { requestId: "req-3", turnId: "turn-3", state: "terminal", outcome: "error", startedAt: 1, endedAt: 2 }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-1" });
    // During the read: an older request's dispatch and its request-less progress and result.
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-2", requestId: "req-2" });
    frame(r, { type: "text_delta", sessionId: A, turnId: "turn-2", text: "Wax first." });
    frame(r, { type: "result", sessionId: A, turnId: "turn-2", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    release();
    await settle(); await settle();
    expect(state(r, A)).toBe("failed");
    expect(r.stores.trackers.getState().evidence[A]!.latest).toMatchObject({ turnId: "turn-3" });
  });

  test("live frames that arrive during a read are applied after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host: Host = { envelopes: new Map([[A, async () => { await gate; return envelope(A, 4, { requestId: "req-4", turnId: "turn-4", state: "running", startedAt: 10 }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    runningIn(r, A, "turn-4");
    r.stores.chat.getState().setActiveSession(B);
    // The read is in flight; the turn ends meanwhile.
    frame(r, { type: "result", sessionId: A, turnId: "turn-4", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    release();
    await settle();
    // The envelope said running, the held frame then ended it: done, not running.
    expect(state(r, A)).toBe("done");
  });

  test("each unavailable read prints its reason", async () => {
    const cases: Array<[() => Response, string]> = [
      [() => Response.json({ error: "SESSION_NOT_FOUND", message: "gone" }, { status: 404 }), "session not found"],
      [() => new Response("", { status: 404 }), "host too old"],
      [() => Response.json({ error: "SESSION_RECOVERY_FAILED", message: "x" }, { status: 500 }), "host unreachable"],
    ];
    for (const [respond, detail] of cases) {
      const r = root({}, { envelopes: new Map([[A, respond]]), urls: [] });
      hello(r);
      runningIn(r, A);
      r.stores.chat.getState().setActiveSession(B);
      await settle();
      expect(trackerWords(views(r)[0]!, 0)).toEqual({ word: "can't check", detail });
    }
  });

  test("an unauthorized read drops needs you; a failed one keeps the approval it knew", async () => {
    const outcome = async (respond: () => Response) => {
      const r = root({}, { envelopes: new Map([[A, respond]]), urls: [] });
      hello(r);
      runningIn(r, A);
      frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-1", toolUseId: "tool-wax", toolName: "Bash", input: {} });
      r.stores.chat.getState().setActiveSession(B);
      await settle();
      return views(r)[0]!;
    };
    expect(await outcome(() => Response.json({ error: "Authentication required", authRequired: true }, { status: 401 }))).toMatchObject({ state: "cant_check", cantCheck: "unauthorized" });
    expect(await outcome(() => Response.json({}, { status: 403 }))).toMatchObject({ state: "cant_check", cantCheck: "unauthorized" });
    expect(await outcome(() => Response.json({ error: "SESSION_RECOVERY_FAILED", message: "x" }, { status: 500 }))).toMatchObject({ state: "needs_you", pendingKind: "approval" });
  });

  test("a turn-scoped error with no result after it asks the host how the turn ended", async () => {
    const host: Host = { envelopes: new Map([[A, () => envelope(A, 2, { requestId: "req-1", turnId: "turn-1", state: "terminal", outcome: "error", startedAt: 10, endedAt: 30 })]]), urls: [] };
    const r = root({}, host);
    hello(r);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    await settle();
    host.urls.length = 0;
    frame(r, { type: "error", sessionId: A, turnId: "turn-1", code: "BACKEND_ERROR", message: "The oars broke.", requestId: "req-1" });
    await settle();
    expect(host.urls).toEqual([`/api/sessions/${A}/recovery`]);
    expect(views(r)[0]).toMatchObject({ state: "failed", endedAt: 30 });
  });

  test("an acceptance held behind a read still proves the send, so its failure is not a refusal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host: Host = { envelopes: new Map([[A, async () => { await gate; return envelope(A, 6, { requestId: "req-mast", state: "unknown" }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    r.stores.connection.getState().setChatRequestAck(true);
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.setMessages(A, []);
    chat.addUserMessage(A, "Bind me to the mast", "typed", undefined, { requestId: "req-mast" });
    r.stores.chat.getState().setActiveSession(B);
    expect(state(r, A)).toBe("unconfirmed");
    // The read is in flight; acceptance and then a routing failure arrive.
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-mast" });
    frame(r, { type: "error", sessionId: A, code: "BACKEND_ERROR", message: "No backend.", requestId: "req-mast" });
    expect(ids(r)).toEqual([A]);
    release();
    await settle();
    expect(ids(r)).toEqual([A]);
    expect(state(r, A)).not.toBe("unconfirmed");
  });

  test("an accepted request failing before its turn, or a dropped follow-up, asks the host again", async () => {
    let reads = 0;
    const host: Host = { envelopes: new Map([[A, () => { reads++; return envelope(A, 5, { requestId: "req-5", state: "queued" }); }]]), urls: [] };
    const r = root({}, host);
    hello(r);
    frame(r, { type: "status", sessionId: A, status: "queued", requestId: "req-5" });
    await settle();
    expect(reads).toBe(1);
    // Accepted, then routing failed: not a refusal.
    frame(r, { type: "error", sessionId: A, code: "BACKEND_ERROR", message: "No backend.", requestId: "req-5" });
    await settle();
    expect(reads).toBe(2);
    expect(r.stores.trackers.getState().refusedRequests).toEqual([]);
    frame(r, { type: "session_queue", sessionId: A, followUps: [], dropped: [{ id: "q-5", requestId: "req-5", reason: "revoked" }] });
    await settle();
    expect(reads).toBe(3);
  });

  test("a read is bounded: a failed request frees the session's live frames", async () => {
    let signal: AbortSignal | undefined;
    const r = createBrainUiRoot({
      storage: null,
      request: async (_url, init) => { signal = init?.signal ?? undefined; throw new DOMException("The operation timed out.", "TimeoutError"); },
    });
    roots.push(r);
    r.stores.connection.setState({ wsStatus: "connected" });
    hello(r);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    await settle();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(r.stores.trackers.getState().reading[A]).toBeUndefined();
    expect(views(r)[0]).toMatchObject({ state: "cant_check", cantCheck: "host_unreachable" });
    frame(r, { type: "text_delta", sessionId: A, turnId: "turn-1", text: "Still rowing." });
    expect(views(r)[0]!.state).toBe("running");
  });

  test("a read begun before the set was deleted cannot settle a newer read", async () => {
    const r = root();
    hello(r, false, "pk-ithaca");
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    const trackers = () => r.stores.trackers.getState();
    expect(trackers().beginRead(A)).toBe(true);
    const stale = trackers().epoch;
    // A different principal: the set goes, and a new tracker starts a new read.
    hello(r, false, "pk-penelope");
    trackers().track(A);
    expect(trackers().beginRead(A)).toBe(true);
    trackers().live(A, [{ kind: "running", turnId: "turn-7", requestId: null }]);
    const ok = { ok: true as const, recovery: { sessionId: A, backendId: null, revision: 9, latest: latest({ state: "running", turnId: "turn-7", startedAt: 5 }), pending: [] } };
    trackers().endRead(A, { ok: false, reason: "host_unreachable" }, stale);
    expect(trackers().reading[A]).toEqual([{ kind: "running", turnId: "turn-7", requestId: null }]);
    trackers().endRead(A, ok, trackers().epoch);
    expect(views(r)[0]).toMatchObject({ state: "running", startedAt: 5, revision: 9 });
  });

  test("after a revocation, leaving a session rebuilds nothing until a hello", () => {
    const storage = memoryStorage();
    const r = root({ storage, storagePrefix: "ithaca" });
    hello(r, false);
    runningIn(r, A);
    r.stores.trackers.getState().revoke();
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "status", sessionId: "odysseus-aeolus", status: "queued", requestId: "req-1" });
    expect(ids(r)).toEqual([]);
    expect(storage.data.has(`ithaca:${TRACKER_STORAGE_KEY}`)).toBe(false);
    hello(r, false);
    frame(r, { type: "status", sessionId: "odysseus-aeolus", status: "queued", requestId: "req-2" });
    expect(ids(r)).toEqual(["odysseus-aeolus"]);
  });

  test("a revocation deletes the whole set", () => {
    const storage = memoryStorage();
    const r = root({ storage, storagePrefix: "ithaca" });
    hello(r, false);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    r.stores.trackers.getState().revoke();
    expect(ids(r)).toEqual([]);
    expect(storage.data.has(`ithaca:${TRACKER_STORAGE_KEY}`)).toBe(false);
  });

  test("activity after leaving is a new turn running, never done by its time", () => {
    const r = root();
    hello(r, false);
    runningIn(r, A);
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-2", requestId: "req-2" });
    expect(state(r, A)).toBe("running");
  });
});
