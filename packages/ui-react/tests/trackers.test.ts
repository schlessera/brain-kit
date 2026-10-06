import { describe, expect, test } from "bun:test";
import type { ServerMessage, SessionRecovery, SessionRecoveryLatest, SessionRecoveryPending } from "@schlessera/brain-ui-sdk/protocol";
import {
  applyLiveEvent,
  applySnapshot,
  applyUnavailable,
  compareTrackers,
  deriveTrackerView,
  emptyEvidence,
  isCleared,
  parseTrackerSet,
  serializeTrackerSet,
  trackerEventsForFrame,
  trackerWords,
  type TrackerEvidence,
  type TrackerRecord,
  type TrackerView,
} from "../src/lib/trackers";

// The tracker model of D52 §4 (#948), pure: merging live frames and recovery
// envelopes, the state table, its words and the stored set. Odysseus's
// voyage supplies the sessions.

const SID = "odysseus-sirens";

function latest(over: Partial<SessionRecoveryLatest>): SessionRecoveryLatest {
  return { requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null, ...over };
}

function envelope(revision: number, over: Partial<SessionRecoveryLatest>, pending: SessionRecoveryPending[] = []): SessionRecovery {
  return { sessionId: SID, backendId: "pi", revision, latest: latest(over), pending };
}

function record(over: Partial<TrackerRecord> = {}): TrackerRecord {
  return { sessionId: SID, requestId: null, turnId: null, revision: null, leftAt: 1000, seen: null, ...over };
}

function live(evidence: TrackerEvidence, ...frames: ServerMessage[]): TrackerEvidence {
  for (const frame of frames) for (const event of trackerEventsForFrame(frame)) evidence = applyLiveEvent(evidence, event);
  return evidence;
}

const view = (evidence: TrackerEvidence, over: Partial<TrackerRecord> = {}, unconfirmed = false, queueNote: string | null = null) =>
  deriveTrackerView(record(over), evidence, { recoverySupported: true, unconfirmed, queueNote });

const frames = {
  info: (turnId: string, requestId?: string) => ({ type: "session_info", sessionId: SID, isNew: false, turnId, ...(requestId ? { requestId } : {}) }) as ServerMessage,
  delta: (turnId: string) => ({ type: "text_delta", sessionId: SID, turnId, text: "The wax is soft." }) as ServerMessage,
  queued: (requestId: string, detail?: string) => ({ type: "status", sessionId: SID, status: "queued", requestId, ...(detail ? { detail } : {}) }) as ServerMessage,
  result: (turnId: string, outcome: "success" | "error" | "cancelled" = "success") =>
    ({ type: "result", sessionId: SID, turnId, outcome, durationMs: 1, numTurns: 1, isError: outcome === "error" }) as ServerMessage,
  approval: (turnId: string, toolUseId: string) =>
    ({ type: "tool_approval_request", sessionId: SID, turnId, toolUseId, toolName: "Bash", input: {} }) as ServerMessage,
};

describe("live frames (rules 3 and 4)", () => {
  test("a request only moves forward, and a terminal state never reverts", () => {
    let e = live(emptyEvidence(), frames.info("turn-1", "req-1"), frames.delta("turn-1"));
    expect(e.latest).toMatchObject({ requestId: "req-1", turnId: "turn-1", state: "running" });
    e = live(e, frames.result("turn-1"));
    expect(e.latest).toMatchObject({ state: "terminal", outcome: "success" });
    // A late frame of the same turn does not reopen it.
    e = live(e, frames.delta("turn-1"));
    expect(e.latest).toMatchObject({ state: "terminal", outcome: "success" });
  });

  test("a follow-up queued behind a running turn is the latest work, and that turn's frames never settle it", () => {
    let e = live(emptyEvidence(), frames.info("turn-1", "req-1"), frames.queued("req-2"));
    expect(e.latest).toMatchObject({ requestId: "req-2", turnId: null, state: "queued" });
    // The running turn keeps streaming and then ends: it is not the latest.
    e = live(e, frames.delta("turn-1"), frames.result("turn-1"));
    expect(e.latest).toMatchObject({ requestId: "req-2", state: "queued" });
    // Its dispatch names its turn.
    e = live(e, frames.info("turn-2", "req-2"));
    expect(e.latest).toMatchObject({ requestId: "req-2", turnId: "turn-2", state: "running" });
  });

  test("a new turn after a finished one is running work, not the old success", () => {
    let e = live(emptyEvidence(), frames.info("turn-1", "req-1"), frames.result("turn-1"));
    e = live(e, frames.delta("turn-2"));
    expect(e.latest).toMatchObject({ turnId: "turn-2", state: "running" });
    expect(view(e).state).toBe("running");
  });

  test("an approval is pending until its result, and a turn's end drops what it raised", () => {
    let e = live(emptyEvidence(), frames.info("turn-1"), frames.approval("turn-1", "tool-wax"));
    expect(e.pending).toEqual([{ kind: "approval", requestId: "tool-wax", turnId: "turn-1" }]);
    expect(live(e, { type: "tool_result", sessionId: SID, toolUseId: "tool-wax", output: "", isError: false } as ServerMessage).pending).toEqual([]);
    expect(live(e, frames.result("turn-1")).pending).toEqual([]);
  });

  test("each ask kind is a pending question with its original identity", () => {
    for (const [type, kind] of [["ask_user_request", "ask_user"], ["ask_user_list_request", "ask_user_list"], ["ask_user_rank_request", "ask_user_rank"], ["ask_user_form_request", "ask_user_form"]] as const) {
      const e = live(emptyEvidence(), { type, sessionId: SID, turnId: "turn-1", requestId: "ask-1" } as unknown as ServerMessage);
      expect(e.pending).toEqual([{ kind, requestId: "ask-1", turnId: "turn-1" }]);
      expect(view(e)).toMatchObject({ state: "needs_you", pendingKind: "question" });
    }
  });

  test("a resume's session_info, naming no turn and no request, is not a new run", () => {
    let e = live(emptyEvidence(), frames.info("turn-1", "req-1"), frames.result("turn-1"));
    e = live(e, { type: "session_info", sessionId: SID, isNew: false } as ServerMessage);
    expect(e.latest).toMatchObject({ turnId: "turn-1", state: "terminal" });
  });

  test("message_blocks and a refused request say nothing about work", () => {
    expect(trackerEventsForFrame({ type: "message_blocks", sessionId: SID, turnId: "turn-1", blocks: [] } as unknown as ServerMessage)).toEqual([]);
    expect(trackerEventsForFrame({ type: "error", sessionId: SID, code: "SESSION_QUEUE_FULL", message: "full", requestId: "req-9" } as ServerMessage)).toEqual([]);
  });
});

describe("recovery envelopes (rules 1, 2 and 5)", () => {
  test("a snapshot below a revision already seen is a rollback: unknown, never the older state", () => {
    let e = applySnapshot(emptyEvidence(), envelope(4, { requestId: "req-4", turnId: "turn-4", state: "running", startedAt: 1 }));
    e = applySnapshot(e, envelope(3, { requestId: "req-3", turnId: "turn-3", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 }));
    expect(e.rolledBack).toBe(true);
    expect(view(e).state).toBe("unknown");
    expect(trackerWords(view(e), 0)).toEqual({ word: "unknown", detail: "host can't confirm the latest turn" });
  });

  test("the stored revision guards a reload: a lower first snapshot is a rollback", () => {
    const e = applySnapshot(emptyEvidence(7), envelope(5, { state: "terminal", outcome: "success" }));
    expect(view(e).state).toBe("unknown");
  });

  test("a newer queued request over an old success shows queued, and the old snapshot cannot mask it", () => {
    let e = applySnapshot(emptyEvidence(), envelope(3, { requestId: "req-3", turnId: "turn-3", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 }));
    e = live(e, frames.queued("req-4", "Queue is holding 9 MB across 3 messages (limit 32 MB)."));
    const queued = view(e, {}, false, "Queue is holding 9 MB across 3 messages (limit 32 MB).");
    expect(queued.state).toBe("queued");
    expect(trackerWords(queued, 0)).toEqual({ word: "queued · busy", detail: "Queue is holding 9 MB across 3 messages (limit 32 MB)." });
    // A snapshot that still counts only r3 is older than what the frames showed.
    e = applySnapshot(e, envelope(3, { requestId: "req-3", turnId: "turn-3", state: "terminal", outcome: "success", startedAt: 1, endedAt: 2 }));
    expect(e.latest).toMatchObject({ requestId: "req-4", state: "queued" });
  });

  test("at one revision the same request moves forward, taking the host's times", () => {
    let e = applySnapshot(emptyEvidence(), envelope(2, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 100 }));
    e = live(e, frames.result("turn-2"));
    // A snapshot fetched before the result arrived still says running.
    e = applySnapshot(e, envelope(2, { requestId: "req-2", turnId: "turn-2", state: "running", startedAt: 100 }));
    expect(e.latest).toMatchObject({ state: "terminal", outcome: "success" });
    e = applySnapshot(e, envelope(2, { requestId: "req-2", turnId: "turn-2", state: "terminal", outcome: "success", startedAt: 100, endedAt: 400 }));
    expect(e.latest).toMatchObject({ state: "terminal", startedAt: 100, endedAt: 400 });
  });

  test("two different requests at one revision contradict each other", () => {
    let e = applySnapshot(emptyEvidence(), envelope(2, { requestId: "req-2", state: "queued" }));
    e = applySnapshot(e, envelope(2, { requestId: "req-other", state: "queued" }));
    expect(view(e).state).toBe("unknown");
  });

  test("each snapshot replaces pending whole, even while it belongs to an earlier turn", () => {
    let e = applySnapshot(emptyEvidence(), envelope(5, { requestId: "req-5", state: "queued" }, [{ kind: "approval", requestId: "tool-wax", turnId: "turn-4" }]));
    expect(view(e)).toMatchObject({ state: "needs_you", pendingKind: "approval" });
    e = applySnapshot(e, envelope(5, { requestId: "req-5", state: "queued" }, []));
    expect(view(e).state).toBe("queued");
  });

  test("an unauthorized read drops needs you; the other failures are can't check with their reason", () => {
    const pending = applySnapshot(emptyEvidence(), envelope(1, { state: "running", turnId: "turn-1" }, [{ kind: "ask_user", requestId: "ask-1", turnId: "turn-1" }]));
    const unauthorized = applyUnavailable(pending, "unauthorized");
    expect(view(unauthorized)).toMatchObject({ state: "cant_check", cantCheck: "unauthorized" });
    expect(unauthorized.pending).toEqual([]);
    const words = (reason: Parameters<typeof applyUnavailable>[1]) => trackerWords(view(applyUnavailable(emptyEvidence(), reason)), 0);
    expect(words("session_not_found")).toEqual({ word: "can't check", detail: "session not found" });
    expect(words("host_too_old")).toEqual({ word: "can't check", detail: "host too old" });
    expect(words("host_unreachable")).toEqual({ word: "can't check", detail: "host unreachable" });
  });

  test("a host without recovery reads can't check · host too old until live frames prove otherwise", () => {
    const none = deriveTrackerView(record(), emptyEvidence(), { recoverySupported: false, unconfirmed: false, queueNote: null });
    expect(trackerWords(none, 0)).toEqual({ word: "can't check", detail: "host too old" });
    const proven = deriveTrackerView(record(), live(emptyEvidence(), frames.info("turn-1")), { recoverySupported: false, unconfirmed: false, queueNote: null });
    expect(proven.state).toBe("running");
  });
});

describe("states and words (D52 §4's table)", () => {
  const at = (h: number, m: number) => new Date(2026, 6, 12, h, m).getTime();

  test("each terminal outcome has its word, and times come only from the host", () => {
    const terminal = (outcome: SessionRecoveryLatest["outcome"], endedAt: number | null) =>
      view(applySnapshot(emptyEvidence(), envelope(1, { turnId: "turn-1", state: "terminal", outcome, startedAt: endedAt === null ? null : at(9, 37), endedAt })));
    expect(trackerWords(terminal("success", at(9, 41)), at(9, 45))).toEqual({ word: "done · 4m", detail: "finished 09:41" });
    expect(trackerWords(terminal("success", null), at(9, 45))).toEqual({ word: "done", detail: null });
    expect(trackerWords(terminal("error", at(9, 41)), 0)).toEqual({ word: "failed", detail: "ended 09:41" });
    expect(trackerWords(terminal("interrupted", at(9, 41)), 0).word).toBe("interrupted");
    expect(trackerWords(terminal("timeout", at(9, 41)), 0).word).toBe("timed out");
    expect(trackerWords(terminal("cancelled", at(9, 2)), 0)).toEqual({ word: "cancelled", detail: "ended 09:02" });
    expect(trackerWords(terminal("denied", at(9, 2)), 0)).toEqual({ word: "denied", detail: "ended 09:02" });
    const running = view(applySnapshot(emptyEvidence(), envelope(1, { turnId: "turn-1", state: "running", startedAt: at(9, 39) })));
    expect(trackerWords(running, at(9, 41))).toEqual({ word: "running · 2m", detail: null });
    expect(trackerWords(view(live(emptyEvidence(), frames.info("turn-1"))), at(9, 41))).toEqual({ word: "running", detail: null });
  });

  test("a send with no acceptance proof is unconfirmed", () => {
    expect(trackerWords(view(emptyEvidence(), {}, true), 0)).toEqual({ word: "unconfirmed", detail: "didn't hear back" });
  });

  test("order is needs you, failed, unconfirmed, running, queued, unknown, can't check, done, cancelled; then newest revision, then most recently left", () => {
    const make = (sessionId: string, state: TrackerView["state"], revision: number | null, leftAt: number): TrackerView =>
      ({ sessionId, state, revision, leftAt } as TrackerView);
    const views = [
      make("cancelled", "cancelled", 9, 1), make("done-old", "done", 1, 5), make("done-new", "done", 2, 1),
      make("cant", "cant_check", null, 1), make("unknown", "unknown", null, 1), make("queued", "queued", 1, 1),
      make("running", "running", 1, 1), make("unconfirmed", "unconfirmed", null, 1), make("failed", "failed", 1, 1),
      make("needs-b", "needs_you", 3, 2), make("needs-a", "needs_you", 3, 2), make("needs-left", "needs_you", 3, 9),
    ];
    expect(views.sort(compareTrackers).map((v) => v.sessionId)).toEqual([
      "needs-left", "needs-a", "needs-b", "failed", "unconfirmed", "running", "queued", "unknown", "cant", "done-new", "done-old", "cancelled",
    ]);
  });

  test("a tracker is cleared only for the latest turn it was seen at; a newer turn brings it back", () => {
    const seen = { turnId: "turn-1", revision: 1, basis: "proof" as const };
    const first = applySnapshot(emptyEvidence(), envelope(1, { requestId: "req-1", turnId: "turn-1", state: "terminal", outcome: "success" }));
    expect(isCleared(record({ seen }), first)).toBe(true);
    const second = live(first, frames.info("turn-2", "req-2"));
    expect(isCleared(record({ seen }), second)).toBe(false);
  });
});

describe("the stored set", () => {
  test("round-trips identifiers only", () => {
    const set = { principalKey: "pk-ithaca", records: { [SID]: record({ requestId: "req-1", turnId: "turn-1", revision: 3, seen: { turnId: "turn-1", revision: 3, basis: "acknowledged" } }) } };
    const raw = serializeTrackerSet(set);
    expect(parseTrackerSet(raw)).toEqual(set);
    expect(Object.keys(JSON.parse(raw).trackers[0]).sort()).toEqual(["leftAt", "requestId", "revision", "seen", "sessionId", "turnId"]);
  });

  test("malformed, older and partly corrupt sets read as empty or skip the bad entries", () => {
    expect(parseTrackerSet("{not json")).toEqual({ principalKey: null, records: {} });
    expect(parseTrackerSet(JSON.stringify({ v: 0, trackers: [record()] }))).toEqual({ principalKey: null, records: {} });
    expect(parseTrackerSet(JSON.stringify([record()]))).toEqual({ principalKey: null, records: {} });
    const mixed = parseTrackerSet(JSON.stringify({ v: 1, principalKey: null, trackers: [record(), { sessionId: 4 }, { ...record({ sessionId: "odysseus-cyclops" }), seen: { turnId: "t", revision: -1, basis: "proof" } }] }));
    expect(Object.keys(mixed.records)).toEqual([SID]);
  });
});
