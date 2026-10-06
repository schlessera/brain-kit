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
