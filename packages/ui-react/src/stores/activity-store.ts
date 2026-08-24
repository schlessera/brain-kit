import { create } from "zustand";
import type {
  ActivitySpan,
  ActivitySpanEvent,
  ServerActivityDelta,
  ServerActivitySnapshot,
} from "@schlessera/brain-ui-sdk/protocol";
import { api } from "../lib/api-client.js";
import { registerDevHandle } from "../config.js";

/** How many finished runs' details are fetched when a session opens. */
const HISTORY_RUN_LIMIT = 10;

/**
 * Client mirror of the server's activity record, fed by the snapshot-then-
 * delta stream. The server computes; this store only holds and indexes what
 * arrived — no aggregation, no derived rollups (those come from the REST
 * activity API).
 *
 * Ordering contract (AE6): a snapshot sets the per-run high-water seq; a
 * delta at or below it is DISCARDED (its content is already in the
 * snapshot). Applying a delta is idempotent — span deltas upsert by spanId,
 * event deltas insert-if-absent by (spanId, eventIndex) — so a duplicate
 * delivery can never corrupt state.
 */
interface ActivityState {
  /** server_hello said this host records activity. */
  supported: boolean;
  /** Session ids this connection has an activity subscription for. */
  subscribed: Record<string, true>;
  /** Live span state per run, keyed runId -> spanId. */
  spans: Record<string, Record<string, ActivitySpan>>;
  /** Ordered events per span (already sorted by eventIndex). */
  events: Record<string, ActivitySpanEvent[]>;
  /** Per-run high-water seq from the snapshot; deltas at or below drop. */
  highWater: Record<string, number>;
  /** spanId -> runId reverse index, for timing lookups by toolUseId. */
  spanRun: Record<string, string>;

  setSupported: (supported: boolean) => void;
  /** New connection: server-side subscriptions are gone; re-subscribe lazily. */
  resetSubscriptions: () => void;
  markSubscribed: (sessionId: string) => void;
  applySnapshot: (msg: ServerActivitySnapshot) => void;
  applyDelta: (msg: ServerActivityDelta) => void;
  clear: () => void;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  supported: false,
  subscribed: {},
  spans: {},
  events: {},
  highWater: {},
  spanRun: {},

  setSupported: (supported) => set({ supported }),

  resetSubscriptions: () => set({ subscribed: {} }),

  markSubscribed: (sessionId) =>
    set((s) => ({ subscribed: { ...s.subscribed, [sessionId]: true } })),

  applySnapshot: (msg) => {
    set((s) => {
      const spans = { ...s.spans };
      const events = { ...s.events };
      const spanRun = { ...s.spanRun };
      for (const span of msg.spans) {
        spans[span.runId] = { ...(spans[span.runId] ?? {}), [span.spanId]: span };
        spanRun[span.spanId] = span.runId;
      }
      for (const event of msg.events) {
        events[event.spanId] = insertEvent(events[event.spanId], event);
      }
      // Append frames repeat the same map; max-merge keeps it monotonic.
      const highWater = { ...s.highWater };
      for (const [runId, seq] of Object.entries(msg.highWaterSeq)) {
        highWater[runId] = Math.max(highWater[runId] ?? 0, seq);
      }
      return { spans, events, highWater, spanRun };
    });
  },

  applyDelta: (msg) => {
    const s = get();
    if (msg.seq <= (s.highWater[msg.runId] ?? 0)) return;
    if (msg.span) {
      const span = msg.span;
      set((prev) => ({
        spans: {
          ...prev.spans,
          [msg.runId]: { ...(prev.spans[msg.runId] ?? {}), [span.spanId]: span },
        },
        spanRun: { ...prev.spanRun, [span.spanId]: msg.runId },
      }));
    } else if (msg.event) {
      const event = msg.event;
      set((prev) => ({
        events: { ...prev.events, [event.spanId]: insertEvent(prev.events[event.spanId], event) },
        spanRun: { ...prev.spanRun, [event.spanId]: prev.spanRun[event.spanId] ?? msg.runId },
      }));
    }
  },

  clear: () => set({ spans: {}, events: {}, highWater: {}, spanRun: {} }),
}));

/** Runs whose history has been fetched already (per page lifetime). */
const loadedHistorySessions = new Set<string>();

/**
 * Pull a session's recent FINISHED runs from the REST activity API into the
 * store. The live subscription's snapshot carries open runs only; this is
 * what makes duration badges on history-loaded messages real (AE2) — span
 * ids are tool-use ids, so the timeline's timing lookup starts hitting.
 * Fire-and-forget; a failure just leaves badges absent, as before.
 */
export async function loadSessionActivityHistory(sessionId: string): Promise<void> {
  if (loadedHistorySessions.has(sessionId)) return;
  loadedHistorySessions.add(sessionId);
  try {
    const { history } = await api.activityRuns({ session: sessionId, limit: HISTORY_RUN_LIMIT });
    const store = useActivityStore.getState();
    for (const run of history.slice(0, HISTORY_RUN_LIMIT)) {
      if (run.detailPruned) continue;
      const detail = await api.activityRun(run.runId);
      if (detail.detailPruned || !detail.spans) continue;
      store.applySnapshot({
        type: "activity_snapshot",
        view: "run",
        runId: run.runId,
        spans: detail.spans,
        events: detail.events ?? [],
        highWaterSeq: { [run.runId]: detail.highWaterSeq ?? 0 },
      });
    }
  } catch {
    // History timing is an enhancement; the transcript renders without it.
    loadedHistorySessions.delete(sessionId);
  }
}

function insertEvent(
  list: ActivitySpanEvent[] | undefined,
  event: ActivitySpanEvent
): ActivitySpanEvent[] {
  const existing = list ?? [];
  if (existing.some((e) => e.eventIndex === event.eventIndex)) return existing;
  const next = [...existing, event];
  next.sort((a, b) => a.eventIndex - b.eventIndex);
  return next;
}

// --- Selectors (plain functions over the state, like activeChat) ---

/** All spans of a run, roots first, then by start time. */
export function runSpans(state: ActivityState, runId: string): ActivitySpan[] {
  const byId = state.spans[runId];
  if (!byId) return [];
  return Object.values(byId).sort((a, b) =>
    a.parentSpanId === b.parentSpanId
      ? a.startedAt - b.startedAt
      : (a.parentSpanId ? 1 : 0) - (b.parentSpanId ? 1 : 0) || a.startedAt - b.startedAt
  );
}

/** Direct children of a span (e.g. the tool calls inside a subagent). */
export function childSpans(state: ActivityState, parentSpanId: string): ActivitySpan[] {
  const runId = state.spanRun[parentSpanId];
  if (!runId) return [];
  return Object.values(state.spans[runId] ?? {})
    .filter((s) => s.parentSpanId === parentSpanId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** The subagent spans spawned by a turn's Agent tool calls, live status included. */
export function subagentSpans(state: ActivityState, sessionId: string): ActivitySpan[] {
  const out: ActivitySpan[] = [];
  for (const byId of Object.values(state.spans)) {
    for (const span of Object.values(byId)) {
      if (span.kind === "subagent" && span.sessionId === sessionId) out.push(span);
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** The span behind one tool call (span ids ARE toolUseIds), if streamed. */
export function spanForTool(state: ActivityState, toolUseId: string): ActivitySpan | null {
  const runId = state.spanRun[toolUseId];
  return runId ? (state.spans[runId]?.[toolUseId] ?? null) : null;
}

/**
 * Server-stamped timing for a tool call. One clock for live and reloaded
 * views: when the activity stream carries the span, its timestamps win over
 * client stamps (AE2 — live and revisit must render identical timings).
 * `waitUntil` marks the approval-wait/execution boundary.
 */
export function timingFor(
  state: ActivityState,
  toolUseId: string
): { startedAt: number; endedAt?: number } | null {
  const span = spanForTool(state, toolUseId);
  if (!span) return null;
  return {
    startedAt: span.waitUntil ?? span.startedAt,
    ...(span.endedAt !== undefined ? { endedAt: span.endedAt } : {}),
  };
}

registerDevHandle(() => {
  if (typeof window === "undefined") return;
  (window as unknown as { __activityStore?: typeof useActivityStore }).__activityStore =
    useActivityStore;
});
