import { afterEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { announcementText, createTrackerAnnouncer } from "../src/lib/tracker-announcer.js";
import type { TrackerView } from "../src/lib/trackers.js";

// Which tracker changes are announced (D52 §3, #950): once, politely, for a
// change into needs you, failed or done; never for running or queued, a
// repeated frame, a ticking age, or what was already the case when the
// tracker was restored or left. Odysseus's voyage supplies the sessions.

const A = "odysseus-sirens";
const B = "odysseus-cyclops";

function view(over: Partial<TrackerView>): TrackerView {
  return {
    sessionId: A, state: "running", outcome: null, pendingKind: null, cantCheck: null, queueNote: null,
    startedAt: null, endedAt: null, revision: null, leftAt: 1, turnId: "turn-1", cleared: false, settled: true, ...over,
  };
}

describe("the announcer", () => {
  test("a settled change into needs you, failed or done is announced once; running and queued are not", () => {
    const a = createTrackerAnnouncer();
    expect(a.observe([view({ state: "running" })]), "a first view is a baseline").toEqual([]);
    expect(a.observe([view({ state: "queued" })])).toEqual([]);
    expect(a.observe([view({ state: "needs_you" })])).toEqual([{ sessionId: A, state: "needs_you", outcome: null }]);
    expect(a.observe([view({ state: "needs_you" })]), "the same frame again").toEqual([]);
    expect(a.observe([view({ state: "running" })])).toEqual([]);
    expect(a.observe([view({ state: "done", outcome: "success" })])).toEqual([{ sessionId: A, state: "done", outcome: "success" }]);
    expect(a.observe([view({ state: "done", outcome: "success", endedAt: 5 })]), "a new time is not a change").toEqual([]);
    // A later turn finishing is a change, though the state word is the same.
    expect(a.observe([view({ state: "done", outcome: "success", turnId: "turn-2" })])).toHaveLength(1);
    expect(a.observe([view({ state: "failed", outcome: "error", turnId: "turn-2" })])).toEqual([{ sessionId: A, state: "failed", outcome: "error" }]);
  });

  test("nothing is said before a view has settled, and the first settled view is the baseline", () => {
    const a = createTrackerAnnouncer();
    expect(a.observe([view({ state: "cant_check", settled: false })])).toEqual([]);
    expect(a.observe([view({ state: "done", settled: true })]), "a restored tracker's first answer").toEqual([]);
  });

  test("work that started unwatched announces its first settled view", () => {
    const a = createTrackerAnnouncer();
    a.background(B);
    expect(a.observe([view({ sessionId: B, state: "cant_check", settled: false })])).toEqual([]);
    expect(a.observe([view({ sessionId: B, state: "needs_you" })])).toEqual([{ sessionId: B, state: "needs_you", outcome: null }]);
    // A session already known is not fresh again.
    a.background(B);
    expect(a.observe([view({ sessionId: B, state: "needs_you" })])).toEqual([]);
  });

  test("a cleared tracker says nothing, and a tracker that went starts over as a baseline", () => {
    const a = createTrackerAnnouncer();
    a.observe([view({ state: "running" })]);
    expect(a.observe([view({ state: "done", cleared: true })])).toEqual([]);
    a.observe([]);
    expect(a.observe([view({ state: "done" })]), "tracked again: a baseline").toEqual([]);
  });

  test("the words", () => {
    expect(announcementText({ sessionId: A, state: "needs_you", outcome: null }, "Tax folder cleanup")).toBe("Tax folder cleanup needs you.");
    expect(announcementText({ sessionId: A, state: "failed", outcome: "error" }, "Raft lashing plan")).toBe("Raft lashing plan failed.");
    expect(announcementText({ sessionId: A, state: "failed", outcome: "interrupted" }, "Raft lashing plan")).toBe("Raft lashing plan was interrupted.");
    expect(announcementText({ sessionId: A, state: "failed", outcome: "timeout" }, "Raft lashing plan")).toBe("Raft lashing plan timed out.");
    expect(announcementText({ sessionId: A, state: "done", outcome: "success" }, "Letter to Penelope")).toBe("Letter to Penelope is done.");
  });
});

// The same rules through one real root: its socket demux, its tracker
// client and its store.
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const r of roots.splice(0)) r.dispose(); });

function root() {
  const r = createBrainUiRoot({ storage: null, request: async () => Response.json({ error: "not found" }, { status: 404 }) });
  r.stores.connection.setState({ wsStatus: "connected" });
  roots.push(r);
  frame(r, { type: "server_hello", protocolRev: 5, principalKey: "pk-ithaca", capabilities: {} });
  return r;
}
const frame = (r: BrainUiRoot, msg: Record<string, unknown>) => r.connection.handleServerMessage(msg as unknown as ServerMessage);
const said = (r: BrainUiRoot) => r.stores.trackers.getState().announcements.map(({ sessionId, state }) => [sessionId, state]);

describe("announcements in a root", () => {
  test("a session left running announces done when it finishes, once", () => {
    const r = root();
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    chat.addUserMessage(A, "Row past the Sirens");
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1" });
    frame(r, { type: "text_delta", sessionId: A, turnId: "turn-1", text: "Wax first." });
    r.connection.flushChatDeltas();
    r.stores.chat.getState().setActiveSession(B);
    frame(r, { type: "text_delta", sessionId: A, turnId: "turn-1", text: " Then the ropes." });
    expect(said(r)).toEqual([]);
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", isError: false, durationMs: 0, numTurns: 1 });
    expect(said(r)).toEqual([[A, "done"]]);
  });

  test("leaving a session that waits on an approval says nothing; one raised unwatched says needs you", () => {
    const r = root();
    const chat = r.stores.chat.getState();
    chat.setActiveSession(A);
    frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1" });
    frame(r, { type: "tool_approval_request", sessionId: A, turnId: "turn-1", toolUseId: "tool-a", toolName: "Write", input: { file_path: "voyage/sirens.md" } });
    r.stores.chat.getState().setActiveSession(B);
    expect(r.stores.trackers.getState().records[A], "tracked").toBeDefined();
    expect(said(r), "the reader saw it waiting").toEqual([]);
    frame(r, { type: "status", sessionId: "odysseus-aeolus", status: "thinking", turnId: "turn-9" });
    frame(r, { type: "tool_approval_request", sessionId: "odysseus-aeolus", turnId: "turn-9", toolUseId: "tool-b", toolName: "Write", input: { file_path: "voyage/winds.md" } });
    expect(said(r)).toEqual([["odysseus-aeolus", "needs_you"]]);
  });
});
