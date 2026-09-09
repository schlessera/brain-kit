import { create } from "zustand";
import { api } from "../lib/api-client.js";
import { registerDevHandle } from "../config.js";
import type { ActivityState, MirrorMaps } from "./activity-store-types.js";
import {
  evictRun,
  insertEvent,
  pruneTerminalRuns,
  rootSpanOf,
} from "./activity-store-helpers.js";

export {
  EMPTY_EVENTS,
  childSpans,
  eventsFor,
  narrativeEventsFor,
  payloadEventsFor,
  runEvents,
  runSpans,
  spanForTool,
  subagentSpans,
  timingFor,
} from "./activity-store-helpers.js";

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
 * delivery can never corrupt state. The guard is symmetric: a snapshot
 * whose per-run high-water is STRICTLY LOWER than what is held (a stale
 * frame racing a reconnect) is skipped for that run; an equal value still
 * applies, so chunked append frames keep working.
 *
 * Bounded mirror: at most MAX_TERMINAL_RUNS finished runs are held — once a
 * run past the cap, the oldest terminal runs (by root start time) are
 * evicted wholesale (spans, events, high-water, reverse index). Live runs
 * are never evicted; evicted history remains fetchable over REST.
 */
export const useActivityStore = create<ActivityState>((set, get) => ({
  supported: false,
  subscribed: {},
  connectionEpoch: 0,
  spans: {},
  events: {},
  highWater: {},
  deltaSeq: {},
  spanRun: {},

  inbox: [],

  loadInbox: async () => {
    try {
      const { intents } = await api.activityInbox();
      set({ inbox: intents });
    } catch {
      // Badge absence over a crash — the inbox is reachable from Activity.
    }
  },

  acknowledgeIntent: async (id) => {
    set((s) => ({ inbox: s.inbox.filter((i) => i.id !== id) }));
    try {
      await api.activityInboxAck(id);
    } catch {
      // Optimistic removal stands; the next load re-syncs.
    }
  },

  acknowledgeAllIntents: async () => {
    set({ inbox: [] });
    try {
      await api.activityInboxAckAll();
    } catch {
      // Same optimistic policy.
    }
  },

  setSupported: (supported) => {
    set({ supported });
    if (supported) startInboxPolling();
  },

  resetSubscriptions: () => set({ subscribed: {} }),

  bumpConnectionEpoch: () => set((s) => ({ connectionEpoch: s.connectionEpoch + 1 })),

  markSubscribed: (sessionId) =>
    set((s) => ({ subscribed: { ...s.subscribed, [sessionId]: true } })),

  applySnapshot: (msg) => {
    set((s) => {
      const maps: MirrorMaps = {
        spans: { ...s.spans },
        events: { ...s.events },
        highWater: { ...s.highWater },
        deltaSeq: { ...s.deltaSeq },
        spanRun: { ...s.spanRun },
      };
      // Staleness guard: a run whose incoming high-water is strictly below
      // what is held (snapshot floor or an applied delta) carries older
      // state than what already applied — skip its spans/events. Equal
      // still applies (chunked append frames).
      const stale = new Set<string>();
      for (const [runId, seq] of Object.entries(msg.highWaterSeq)) {
        const held = Math.max(maps.highWater[runId] ?? 0, maps.deltaSeq[runId] ?? 0);
        if (seq < held) stale.add(runId);
        else maps.highWater[runId] = seq;
      }
      for (const span of msg.spans) {
        if (stale.has(span.runId)) continue;
        maps.spans[span.runId] = { ...(maps.spans[span.runId] ?? {}), [span.spanId]: span };
        maps.spanRun[span.spanId] = span.runId;
      }
      for (const event of msg.events) {
        const runId = maps.spanRun[event.spanId];
        if (runId !== undefined && stale.has(runId)) continue;
        maps.events[event.spanId] = insertEvent(maps.events[event.spanId], event);
      }
      // Scope eviction: a fresh session/index snapshot is authoritative for
      // its scope. A held run that still looks live but is absent from the
      // frame's high-water map is a ghost — the server says it is not
      // running any more (its REST history remains fetchable).
      if (!msg.append && (msg.view === "session" || msg.view === "index")) {
        for (const [runId, byId] of Object.entries(maps.spans)) {
          if (runId in msg.highWaterSeq) continue;
          const root = rootSpanOf(byId);
          if (!root || root.outcome !== undefined) continue;
          const inScope = msg.view === "index" || root.sessionId === msg.sessionId;
          if (inScope) evictRun(maps, runId);
        }
      }
      pruneTerminalRuns(maps);
      return maps;
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
        // Recording the applied seq keeps the snapshot staleness guard
        // honest: a snapshot frame older than this delta must not roll it back.
        deltaSeq: {
          ...prev.deltaSeq,
          [msg.runId]: Math.max(prev.deltaSeq[msg.runId] ?? 0, msg.seq),
        },
        // The mapping is almost always already present — re-spreading it on
        // every delta would churn a large object for nothing.
        ...(prev.spanRun[span.spanId] === msg.runId
          ? {}
          : { spanRun: { ...prev.spanRun, [span.spanId]: msg.runId } }),
      }));
      // A root span closing may push the mirror past the terminal-run cap.
      if (span.parentSpanId === undefined && span.outcome !== undefined) {
        const prev = get();
        const maps: MirrorMaps = {
          spans: { ...prev.spans },
          events: { ...prev.events },
          highWater: { ...prev.highWater },
          deltaSeq: { ...prev.deltaSeq },
          spanRun: { ...prev.spanRun },
        };
        if (pruneTerminalRuns(maps)) set(maps);
      }
    } else if (msg.event) {
      const event = msg.event;
      set((prev) => ({
        events: { ...prev.events, [event.spanId]: insertEvent(prev.events[event.spanId], event) },
        deltaSeq: {
          ...prev.deltaSeq,
          [msg.runId]: Math.max(prev.deltaSeq[msg.runId] ?? 0, msg.seq),
        },
        ...(prev.spanRun[event.spanId] !== undefined
          ? {}
          : { spanRun: { ...prev.spanRun, [event.spanId]: msg.runId } }),
      }));
    }
  },

  clear: () => set({ spans: {}, events: {}, highWater: {}, deltaSeq: {}, spanRun: {} }),
}));

/** One badge poller per page lifetime — the inbox is cheap and the badge
 *  must be honest even when the Activity surface never opens. */
let inboxPoller: ReturnType<typeof setInterval> | null = null;
function startInboxPolling() {
  if (inboxPoller) return;
  void useActivityStore.getState().loadInbox();
  inboxPoller = setInterval(() => {
    void useActivityStore.getState().loadInbox();
  }, 60_000);
}

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
    const details = await Promise.all(
      history
        .slice(0, HISTORY_RUN_LIMIT)
        .filter((run) => !run.detailPruned)
        .map((run) => api.activityRun(run.runId))
    );
    for (const detail of details) {
      if (detail.detailPruned || !detail.spans) continue;
      store.applySnapshot({
        type: "activity_snapshot",
        view: "run",
        runId: detail.runId,
        spans: detail.spans,
        events: detail.events ?? [],
        highWaterSeq: { [detail.runId]: detail.highWaterSeq ?? 0 },
      });
    }
  } catch {
    // History timing is an enhancement; the transcript renders without it.
    loadedHistorySessions.delete(sessionId);
  }
}

/** Runs whose payload events have been backfilled over REST (per page lifetime). */
const payloadLoadedRuns = new Set<string>();

/**
 * Backfill one finished run's tool payload events into the mirror. The
 * history fetch above and the run-list default deliberately skip payload
 * bodies — they exist for duration badges, not drill-ins — so the first
 * expanded payload view of a history span pulls the full detail
 * (`include=payloads`) and merges it. Live runs never need this: their
 * payload events ride the delta stream. The merge is safe because a snapshot
 * at the same high-water still applies and events insert-if-absent.
 */
export async function loadSpanPayloads(spanId: string): Promise<void> {
  const state = useActivityStore.getState();
  const runId = state.spanRun[spanId];
  if (!runId || payloadLoadedRuns.has(runId)) return;
  const root = rootSpanOf(state.spans[runId] ?? {});
  if (!root || root.outcome === undefined) return;
  payloadLoadedRuns.add(runId);
  try {
    const detail = await api.activityRun(runId, { includePayloads: true });
    if (detail.detailPruned || !detail.spans) return;
    useActivityStore.getState().applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId,
      spans: detail.spans,
      events: detail.events ?? [],
      highWaterSeq: { [runId]: detail.highWaterSeq ?? 0 },
    });
  } catch {
    // Payloads are an enhancement; the row keeps its no-payload notice.
    payloadLoadedRuns.delete(runId);
  }
}

registerDevHandle(() => {
  if (typeof window === "undefined") return;
  (window as unknown as { __activityStore?: typeof useActivityStore }).__activityStore =
    useActivityStore;
});
