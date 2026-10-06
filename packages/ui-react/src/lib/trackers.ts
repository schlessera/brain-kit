import {
  isFailureOutcome,
  type ActivitySpanOutcome,
  type ServerMessage,
  type SessionRecovery,
  type SessionRecoveryLatest,
  type SessionRecoveryPending,
  type SessionRecoveryPendingKind,
  type SessionRecoveryUnavailable,
} from "@schlessera/brain-ui-sdk/protocol";

/**
 * Trackers for work left running (D52 §4, #948): the pure part. A tracker is
 * a session the reader left with something in flight, or whose work started
 * while they were elsewhere. It stays until the session's latest turn is
 * seen. Nothing here reads a timestamp to decide state: `lastActiveAt` and
 * the buffers' `lastTouched` are never consulted, because a newer activity
 * time also accompanies a new running turn (#942).
 *
 * The stored record is identifiers only. Everything the reader is shown
 * comes from evidence: the host's recovery envelope (#964), and the live
 * frames that arrive between reads.
 */

/** What one root stores per tracked session, under `${storagePrefix}:trackers:v1`. */
export interface TrackerRecord {
  sessionId: string;
  /** Latest accepted request known for the session. */
  requestId: string | null;
  /** Its turn; null while queued or unknown. */
  turnId: string | null;
  /** Highest host accepted-work revision seen, if any. Guards against rollback after a reload. */
  revision: number | null;
  /** Client clock when the session was last left; ordering only. */
  leftAt: number;
  /**
   * The latest turn the reader saw (`proof`, written only by the seen
   * observer) or acknowledged without proof (`acknowledged`, D52 R1).
   */
  seen: TrackerSeen | null;
}

export interface TrackerSeen {
  turnId: string;
  revision: number;
  basis: "proof" | "acknowledged";
}

/** What this page knows about one session's work. Never persisted. */
export interface TrackerEvidence {
  /** Highest host revision seen, from a snapshot or the stored record. */
  revision: number | null;
  /**
   * `latest` came from a live frame after the last snapshot, so the host has
   * accepted work that `revision` does not yet count.
   */
  ahead: boolean;
  latest: SessionRecoveryLatest | null;
  /**
   * The turn that was running when the latest request was accepted into the
   * queue: its late frames belong to it, not to the queued request.
   */
  behind: string | null;
  /**
   * Turns that `latest` has moved past, newest last. The host keeps a
   * turn's identity on its late emissions, so a frame from one of these
   * is that old turn speaking, never newer work.
   */
  past: string[];
  /** Live interactions waiting on a person, by original identity. */
  pending: SessionRecoveryPending[];
  /** A snapshot came back below a revision already seen. */
  rolledBack: boolean;
  /**
   * The stored record's request and turn, from before a reload. A first
   * snapshot at the stored revision that names different work contradicts
   * it, since that work was accepted after the revision was read.
   */
  stored: { requestId: string | null; turnId: string | null } | null;
  /** Why the last read gave no envelope; cleared by an envelope or by live proof. */
  unavailable: SessionRecoveryUnavailable | null;
  /** Some read or live frame has answered for this session since the page loaded. */
  settled: boolean;
}

export function emptyEvidence(revision: number | null = null, stored: TrackerEvidence["stored"] = null): TrackerEvidence {
  return { revision, ahead: false, latest: null, behind: null, past: [], pending: [], rolledBack: false, stored, unavailable: null, settled: false };
}

/** What a page knows about a tracked session before anything has answered: its stored record. */
export function evidenceFromRecord(record: TrackerRecord | undefined): TrackerEvidence {
  if (!record) return emptyEvidence();
  const stored = record.requestId !== null || record.turnId !== null ? { requestId: record.requestId, turnId: record.turnId } : null;
  return emptyEvidence(record.revision, stored);
}

/** What a live frame says about its session's work. */
export type TrackerLiveEvent =
  | { kind: "queued"; requestId: string | null }
  | { kind: "running"; turnId: string | null; requestId: string | null }
  | { kind: "terminal"; turnId: string | null; outcome: ActivitySpanOutcome }
  | { kind: "pending"; entry: SessionRecoveryPending }
  | { kind: "settled"; requestId: string };

const ASK_KIND: Partial<Record<ServerMessage["type"], SessionRecoveryPendingKind>> = {
  ask_user_request: "ask_user",
  ask_user_list_request: "ask_user_list",
  ask_user_rank_request: "ask_user_rank",
  ask_user_form_request: "ask_user_form",
};

/**
 * The tracker events one scoped frame carries. `message_blocks` arrives
 * after its turn's result and says nothing about work; a refused request
 * (`error` with a `requestId` and no turn) was never accepted.
 */
export function trackerEventsForFrame(msg: ServerMessage): TrackerLiveEvent[] {
  const turnId = (msg as { turnId?: string }).turnId ?? null;
  switch (msg.type) {
    case "session_info":
      // Work only when it names a running turn or acknowledges a request. A
      // resume re-announces an idle session the same way, with neither.
      return turnId !== null || msg.requestId
        ? [{ kind: "running", turnId, requestId: msg.requestId ?? null }]
        : [];
    case "status":
      if (msg.status === "queued") return [{ kind: "queued", requestId: msg.requestId ?? null }];
      if (msg.status === "cancelled") return [{ kind: "terminal", turnId, outcome: "cancelled" }];
      if (msg.status === "idle") return [];
      return [{ kind: "running", turnId, requestId: null }];
    case "text_delta":
    case "thinking_delta":
    case "tool_use_start":
    case "tool_input_delta":
    case "tool_use_complete":
      return [{ kind: "running", turnId, requestId: null }];
    case "tool_approval_request":
      return turnId
        ? [{ kind: "running", turnId, requestId: null }, { kind: "pending", entry: { kind: "approval", requestId: msg.toolUseId, turnId } }]
        : [{ kind: "running", turnId, requestId: null }];
    case "ask_user_request":
    case "ask_user_list_request":
    case "ask_user_rank_request":
    case "ask_user_form_request":
      return turnId
        ? [{ kind: "running", turnId, requestId: null }, { kind: "pending", entry: { kind: ASK_KIND[msg.type]!, requestId: msg.requestId, turnId } }]
        : [{ kind: "running", turnId, requestId: null }];
    case "tool_result":
      return [{ kind: "settled", requestId: msg.toolUseId }];
    case "session_queue": {
      // The host's report of what it holds (#1002), re-sent on reconnect:
      // a follow-up handed to the agent is its turn running, and the
      // newest one still waiting is the session's latest accepted work.
      const events: TrackerLiveEvent[] = [];
      if (msg.started) events.push({ kind: "running", turnId: msg.started.turnId, requestId: msg.started.requestId ?? null });
      const newest = msg.followUps.at(-1);
      if (newest) events.push({ kind: "queued", requestId: newest.requestId ?? null });
      return events;
    }
    case "ask_answer_receipt":
      // Accepted or closed, the question is no longer waiting on anyone;
      // a refused submission leaves it waiting for a valid answer.
      return msg.state === "pending" || msg.reason === "refused" ? [] : [{ kind: "settled", requestId: msg.requestId }];
    case "result": {
      const outcome: ActivitySpanOutcome =
        msg.outcome ?? (msg.isError ? "error" : "success");
      return [{ kind: "terminal", turnId, outcome }];
    }
    default:
      return [];
  }
}

/** Whether these events are work in the session: starting, running or waiting on a person. */
export function isWork(events: readonly TrackerLiveEvent[]): boolean {
  return events.some((e) => e.kind === "queued" || e.kind === "running" || e.kind === "pending");
}

function fresh(requestId: string | null, turnId: string | null, state: "queued" | "running"): SessionRecoveryLatest {
  return { requestId, turnId, state, outcome: null, startedAt: null, endedAt: null };
}

/** Live proof replaces an unavailable read and a rollback: the frame is the host speaking now. */
/** How many superseded turns are remembered; enough for any burst of late frames. */
const PAST_TURNS = 16;

/** `past` after `latest` moves from `previous` to `next`. */
function superseded(past: string[], previous: SessionRecoveryLatest | null, next: SessionRecoveryLatest): string[] {
  const old = previous?.turnId ?? null;
  if (old === null || old === next.turnId || past.includes(old)) return past;
  return [...past, old].slice(-PAST_TURNS);
}

function proven(evidence: TrackerEvidence, latest: SessionRecoveryLatest, ahead: boolean, behind = evidence.behind): TrackerEvidence {
  return { ...evidence, latest, ahead, behind, past: superseded(evidence.past, evidence.latest, latest), rolledBack: false, unavailable: null, settled: true };
}

/**
 * Merge one live frame (D52 §4 rules 3 and 4). A request only moves forward,
 * queued → running → terminal, and a terminal state never reverts. A newer
 * accepted request replaces `latest`, and a known old outcome never masks it.
 */
export function applyLiveEvent(evidence: TrackerEvidence, event: TrackerLiveEvent): TrackerEvidence {
  const latest = evidence.latest;
  switch (event.kind) {
    case "queued": {
      if (event.requestId !== null && latest?.requestId === event.requestId) return evidence;
      // Late frames of the turn running now belong to it, not to this
      // request; a request queued behind another queued one waits behind
      // the same turn.
      const behind = latest?.state === "running" ? latest.turnId : latest?.state === "queued" ? evidence.behind : null;
      return proven(evidence, fresh(event.requestId, null, "queued"), true, behind);
    }
    case "running": {
      const { turnId, requestId } = event;
      // A late frame of a turn already superseded.
      if (turnId !== null && turnId !== latest?.turnId && evidence.past.includes(turnId)) return evidence;
      if (!latest) return proven(evidence, { ...fresh(requestId, turnId, "running") }, true, null);
      if (latest.state === "unknown" && latest.turnId === null && latest.requestId !== null && requestId === null) {
        // The latest request's fate is unknown. A frame naming no request
        // may be an earlier turn still running (a reconnect announces it
        // that way), and must not stand in for it.
        return evidence;
      }
      if (latest.state === "queued" && latest.turnId === null) {
        // Only the request's own dispatch starts it: the turn's
        // `session_info` carries its requestId. Any other frame may be an
        // older turn still running, whose id this page may never have seen.
        // Without a requestId to match, the turn it waits behind is the one
        // turn known not to be its dispatch.
        if (latest.requestId !== null) {
          if (requestId !== latest.requestId) return evidence;
        } else if (requestId === null && (turnId === null || turnId === evidence.behind)) {
          return evidence;
        }
        return proven(evidence, { ...latest, turnId, state: "running", requestId: latest.requestId ?? requestId }, evidence.ahead, null);
      }
      const sameTurn = turnId !== null && latest.turnId === turnId;
      if (sameTurn) {
        if (latest.state === "terminal") return evidence;
        // The turn is live now: that also answers a failed or rolled-back read.
        if (latest.state === "running" && !evidence.unavailable && !evidence.rolledBack) return evidence;
        return proven(evidence, { ...latest, state: "running" }, evidence.ahead, null);
      }
      if (turnId === null) {
        // A host without turn identities: one run at a time, so work after a
        // terminal state is a new run, and anything else is the same one.
        if (latest.turnId === null && latest.state === "running") return evidence;
        if (latest.state !== "terminal" && latest.state !== "unknown") return evidence;
        return proven(evidence, fresh(requestId, null, "running"), true, null);
      }
      if (latest.state === "running" && latest.turnId === null && (requestId === null || requestId === latest.requestId)) {
        // The same run, now named.
        return proven(evidence, { ...latest, turnId }, evidence.ahead, null);
      }
      // A different turn is working: one session runs one turn at a time.
      return proven(evidence, fresh(requestId, turnId, "running"), true, null);
    }
    case "terminal": {
      const pending = event.turnId === null ? evidence.pending : evidence.pending.filter((p) => p.turnId !== event.turnId);
      const next = pending === evidence.pending ? evidence : { ...evidence, pending };
      if (!latest) {
        // A restored tracker's own turn ending is proof, before any read.
        const stored = evidence.stored;
        if (!stored || stored.turnId === null || stored.turnId !== event.turnId) return next;
        return proven(next, { ...fresh(stored.requestId, stored.turnId, "running"), state: "terminal", outcome: event.outcome }, next.ahead);
      }
      if (latest.state === "terminal" || latest.state === "queued") return next;
      if (latest.turnId !== event.turnId) return next;
      return proven(next, { ...latest, state: "terminal", outcome: event.outcome, endedAt: null }, next.ahead);
    }
    case "pending": {
      if (evidence.pending.some((p) => p.requestId === event.entry.requestId)) return evidence;
      return { ...evidence, pending: [...evidence.pending, event.entry], unavailable: null, settled: true };
    }
    case "settled": {
      if (!evidence.pending.some((p) => p.requestId === event.requestId)) return evidence;
      return { ...evidence, pending: evidence.pending.filter((p) => p.requestId !== event.requestId) };
    }
  }
}

function sameRequest(a: SessionRecoveryLatest, b: SessionRecoveryLatest): boolean {
  if (a.requestId !== null && b.requestId !== null) return a.requestId === b.requestId;
  if (a.turnId !== null && b.turnId !== null) return a.turnId === b.turnId;
  return a.requestId === b.requestId && a.turnId === b.turnId;
}

/** One request, two observations: keep whichever is further along. */
function forward(current: SessionRecoveryLatest, snapshot: SessionRecoveryLatest): SessionRecoveryLatest {
  if (current.state === "terminal") return snapshot.state === "terminal" ? snapshot : current;
  if (snapshot.state === "queued" && current.state === "running") return current;
  return { ...snapshot, turnId: snapshot.turnId ?? current.turnId, requestId: snapshot.requestId ?? current.requestId };
}

/**
 * Merge one recovery envelope (D52 §4 rules 1, 2, 4 and 5). The highest
 * revision wins; a lower one than already seen is a rollback, which makes
 * the tracker `unknown` rather than showing the older state. `pending` is
 * replaced whole, since the host lists what is live now.
 */
export function applySnapshot(evidence: TrackerEvidence, recovery: SessionRecovery): TrackerEvidence {
  const base = { ...evidence, pending: recovery.pending, unavailable: null, settled: true };
  const seen = evidence.revision;
  // A contradicted snapshot proves nothing, its pending list included, and
  // the host it came from no longer vouches for what was pending before:
  // until a live frame or a consistent read says otherwise, nothing is.
  const rolledBack: TrackerEvidence = { ...evidence, pending: [], unavailable: null, settled: true, rolledBack: true };
  if (seen !== null && recovery.revision < seen) return rolledBack;
  const latest = evidence.latest;
  if (!latest && seen !== null && recovery.revision === seen && evidence.stored && !sameRequest({ ...recovery.latest, ...evidence.stored }, recovery.latest)) {
    return rolledBack;
  }
  if (seen === null || recovery.revision > seen || !latest) {
    // The first snapshot to count work the frames already showed: the
    // request still only moves forward.
    const next = latest && sameRequest(latest, recovery.latest) ? forward(latest, recovery.latest) : recovery.latest;
    return { ...base, revision: recovery.revision, latest: next, ahead: false, behind: null, past: latest ? superseded(evidence.past, latest, next) : evidence.past, rolledBack: false };
  }
  // Equal revision.
  if (sameRequest(latest, recovery.latest)) {
    return { ...base, latest: forward(latest, recovery.latest), rolledBack: false };
  }
  // The live frames already showed newer work than this snapshot counts:
  // an older answer never masks it.
  if (evidence.ahead) return base;
  // Two different requests at one revision contradict each other.
  return rolledBack;
}

/** A read that gave no envelope (D52 §6). Unauthorized drops what was pending. */
export function applyUnavailable(evidence: TrackerEvidence, reason: SessionRecoveryUnavailable): TrackerEvidence {
  return { ...evidence, unavailable: reason, settled: true, ...(reason === "unauthorized" ? { pending: [] } : {}) };
}

/** States, in display order (D52 §4). */
export const TRACKER_STATES = [
  "needs_you",
  "failed",
  "unconfirmed",
  "running",
  "queued",
  "unknown",
  "cant_check",
  "done",
  "cancelled",
] as const;
export type TrackerState = (typeof TRACKER_STATES)[number];

export type TrackerCantCheck = SessionRecoveryUnavailable;

export interface TrackerView {
  sessionId: string;
  state: TrackerState;
  /** The Activity outcome behind `failed`, `done` and `cancelled`. */
  outcome: ActivitySpanOutcome | null;
  /** For `needs_you`: an approval, or one of the four ask kinds. */
  pendingKind: "approval" | "question" | null;
  /** For `cant_check`: why. */
  cantCheck: TrackerCantCheck | null;
  /** The host's queue note for a `queued` state, verbatim. */
  queueNote: string | null;
  /** Host clock only; null when the host has not said. */
  startedAt: number | null;
  endedAt: number | null;
  revision: number | null;
  leftAt: number;
  /** The latest turn this tracker clears on, when known. */
  turnId: string | null;
  /** The latest turn has been seen or acknowledged: the tracker is not shown. */
  cleared: boolean;
  /** Something has answered for this session since load. Until then nothing should be announced. */
  settled: boolean;
}

export interface TrackerContext {
  /** `server_hello.capabilities.sessionRecovery`; null before any hello. */
  recoverySupported: boolean | null;
  /** A send in this session with no acceptance proof (D52 §5). */
  unconfirmed: boolean;
  queueNote: string | null;
}

/** The key a seen observation must match: the latest turn and its revision. */
export function seenKey(record: TrackerRecord, evidence: TrackerEvidence): { turnId: string; revision: number } | null {
  // After a rollback the latest turn is not known: nothing can be seen,
  // and nothing seen before still clears it.
  if (evidence.rolledBack) return null;
  const turnId = evidence.latest?.turnId ?? null;
  if (turnId === null) return null;
  return { turnId, revision: evidence.revision ?? record.revision ?? 0 };
}

/**
 * The latest turn is the one the reader saw. A turn id names one turn, so it
 * decides; the revision guarded the observation that wrote it (see
 * `observeSeen`), and a snapshot that later counts the same turn's
 * acceptance does not bring the tracker back.
 */
export function isCleared(record: TrackerRecord, evidence: TrackerEvidence): boolean {
  const key = seenKey(record, evidence);
  return !!record.seen && !!key && record.seen.turnId === key.turnId && record.seen.revision <= key.revision;
}

/** One tracker's state, from evidence only (D52 §4's table). */
export function deriveTrackerView(record: TrackerRecord, evidence: TrackerEvidence, context: TrackerContext): TrackerView {
  const latest = evidence.latest;
  const view: TrackerView = {
    sessionId: record.sessionId,
    state: "cant_check",
    outcome: null,
    pendingKind: null,
    cantCheck: null,
    queueNote: null,
    startedAt: latest?.startedAt ?? null,
    endedAt: latest?.endedAt ?? null,
    revision: evidence.revision ?? record.revision,
    leftAt: record.leftAt,
    turnId: latest?.turnId ?? null,
    cleared: isCleared(record, evidence),
    settled: evidence.settled,
  };
  if (evidence.pending.length > 0) {
    return { ...view, state: "needs_you", pendingKind: evidence.pending.some((p) => p.kind === "approval") ? "approval" : "question" };
  }
  if (latest?.state === "terminal" && isFailureOutcome(latest.outcome) && !evidence.rolledBack && !evidence.unavailable) {
    return { ...view, state: "failed", outcome: latest.outcome };
  }
  if (context.unconfirmed) return { ...view, state: "unconfirmed" };
  if (evidence.unavailable) return { ...view, state: "cant_check", cantCheck: evidence.unavailable };
  if (evidence.rolledBack) return { ...view, state: "unknown" };
  if (!latest) {
    return {
      ...view,
      state: "cant_check",
      cantCheck: context.recoverySupported === false ? "host_too_old" : "host_unreachable",
    };
  }
  switch (latest.state) {
    case "running":
      return { ...view, state: "running" };
    case "queued":
      return { ...view, state: "queued", queueNote: context.queueNote };
    case "unknown":
      return { ...view, state: "unknown" };
    case "terminal":
      if (latest.outcome === "cancelled" || latest.outcome === "denied") return { ...view, state: "cancelled", outcome: latest.outcome };
      return { ...view, state: "done", outcome: latest.outcome };
  }
}

/**
 * Display order: by state, then newest revision, then most recently left,
 * then session id, so equal trackers never swap between renders.
 */
export function compareTrackers(a: TrackerView, b: TrackerView): number {
  const byState = TRACKER_STATES.indexOf(a.state) - TRACKER_STATES.indexOf(b.state);
  if (byState !== 0) return byState;
  const revision = (b.revision ?? -1) - (a.revision ?? -1);
  if (revision !== 0) return revision;
  if (a.leftAt !== b.leftAt) return b.leftAt - a.leftAt;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** `done` and `cancelled` beyond this leave the pill row; their Sessions row still says unseen (D52 §4). */
export const SETTLED_TRACKER_CAP = 24;

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const FAILED_WORD: Partial<Record<ActivitySpanOutcome, string>> = {
  error: "failed",
  interrupted: "interrupted",
  timeout: "timed out",
};

const CANT_CHECK_LINE: Record<TrackerCantCheck, string | null> = {
  host_unreachable: "host unreachable",
  host_too_old: "host too old",
  session_not_found: "session not found",
  unauthorized: null,
};

/**
 * The printed words for one tracker (D52 §4): the pill's state word and its
 * second line. Times come only from the host's `startedAt` / `endedAt`;
 * without them nothing is printed.
 */
export function trackerWords(view: TrackerView, now: number): { word: string; detail: string | null } {
  switch (view.state) {
    case "needs_you":
      return { word: "needs you", detail: view.pendingKind };
    case "failed":
      return { word: FAILED_WORD[view.outcome!] ?? "failed", detail: view.endedAt !== null ? `ended ${clock(view.endedAt)}` : null };
    case "unconfirmed":
      return { word: "unconfirmed", detail: "didn't hear back" };
    case "running":
      return { word: view.startedAt !== null ? `running · ${age(now - view.startedAt)}` : "running", detail: null };
    case "queued":
      return { word: view.queueNote ? "queued · busy" : "queued", detail: view.queueNote };
    case "unknown":
      return { word: "unknown", detail: "host can't confirm the latest turn" };
    case "cant_check":
      return { word: "can't check", detail: view.cantCheck ? CANT_CHECK_LINE[view.cantCheck] : null };
    case "done":
      return { word: view.endedAt !== null ? `done · ${age(now - view.endedAt)}` : "done", detail: view.endedAt !== null ? `finished ${clock(view.endedAt)}` : null };
    case "cancelled":
      return { word: view.outcome === "denied" ? "denied" : "cancelled", detail: view.endedAt !== null ? `ended ${clock(view.endedAt)}` : null };
  }
}

// --- Stored set ---------------------------------------------------------

export const TRACKER_STORAGE_KEY = "trackers:v1";

export interface TrackerSet {
  /** `server_hello.principalKey` the set was recorded under; a different one deletes it. */
  principalKey: string | null;
  records: Record<string, TrackerRecord>;
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const isIdOrNull = (value: unknown): value is string | null => value === null || isId(value);
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseRecord(value: unknown): TrackerRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (!isId(r.sessionId) || !isIdOrNull(r.requestId) || !isIdOrNull(r.turnId)) return null;
  if (!(r.revision === null || isRevision(r.revision))) return null;
  if (typeof r.leftAt !== "number" || !Number.isFinite(r.leftAt)) return null;
  let seen: TrackerSeen | null = null;
  if (r.seen !== null) {
    const s = r.seen as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object" || !isId(s.turnId) || !isRevision(s.revision) || (s.basis !== "proof" && s.basis !== "acknowledged")) return null;
    seen = { turnId: s.turnId, revision: s.revision, basis: s.basis };
  }
  return { sessionId: r.sessionId, requestId: r.requestId, turnId: r.turnId, revision: r.revision, leftAt: r.leftAt, seen };
}

/** Read a stored set. Anything malformed, or from another version, reads as empty or is skipped. */
export function parseTrackerSet(raw: string | null): TrackerSet {
  const empty: TrackerSet = { principalKey: null, records: {} };
  if (!raw) return empty;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return empty; }
  if (!value || typeof value !== "object") return empty;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || !Array.isArray(v.trackers) || !isIdOrNull(v.principalKey ?? null)) return empty;
  const records: Record<string, TrackerRecord> = {};
  for (const item of v.trackers) {
    const record = parseRecord(item);
    if (record) records[record.sessionId] = record;
  }
  return { principalKey: (v.principalKey as string | null | undefined) ?? null, records };
}

export function serializeTrackerSet(set: TrackerSet): string {
  return JSON.stringify({ v: 1, principalKey: set.principalKey, trackers: Object.values(set.records) });
}
