/**
 * Live activity streaming: view-scoped subscriptions, snapshot-then-delta.
 *
 * All emission is change-log driven — one code path for the server's own
 * writes and a foreign writer's (the cron wrapper). A write on this process
 * calls `pump()` directly (near-zero latency); foreign writes are picked up
 * by a fast poll interval that runs ONLY while at least one subscription is
 * live. The pump reads `changesSince(cursor)` and fans each committed change
 * out as an `activity_delta` to matching subscribers, so ordering is the
 * change log's and a delta can never precede its commit (persist-then-emit).
 *
 * The subscribe handler answers with a snapshot whose per-run high-water seq
 * and pump baseline come from ONE store read transaction — there is no gap
 * window between snapshot and first delta, and no duplication the client's
 * seq-discard rule cannot handle.
 *
 * This is deliberately the only place broadcast is per-connection filtered;
 * every other frame keeps the host's broadcast-to-all semantics.
 */
import type {
  ActivitySpan,
  ActivitySpanEvent,
  ClientActivitySubscribe,
  ClientActivityUnsubscribe,
  ServerActivityDelta,
  ServerActivitySnapshot,
} from "@schlessera/brain-ui-sdk/protocol";
import type { Logger } from "@opentelemetry/api-logs";

import type { WSContext } from "../ws/clients.js";
import { sendTo } from "../ws/clients.js";
import type { ActivityChange, ActivityStore, SpanEventRow, SpanRow } from "./store.js";

/** Events per snapshot frame — keeps each frame far below the WS size cap. */
const SNAPSHOT_EVENT_CHUNK = 100;
/** Fast-poll cadence while subscriptions exist (foreign-writer liveness). */
const POLL_INTERVAL_MS = 1500;

interface Subscription {
  view: "index" | "session" | "run";
  sessionId?: string;
  runId?: string;
}

export interface ActivityStream {
  handleSubscribe(ws: WSContext, msg: ClientActivitySubscribe): void;
  handleUnsubscribe(ws: WSContext, msg: ClientActivityUnsubscribe): void;
  /** Forget a closed socket. */
  dropConnection(ws: WSContext): void;
  /** Drain new committed changes to subscribers. Reentrancy-safe. */
  pump(): void;
  /** Whether any connection currently watches the given session's activity. */
  isWatched(scope: { sessionId?: string; runId?: string }): boolean;
  /** Number of live subscriptions (all connections). */
  subscriptionCount(): number;
  close(): void;
}

export function createActivityStream(store: ActivityStore, log?: Logger): ActivityStream {
  const subscriptions = new Map<WSContext, Subscription[]>();
  let cursor = store.latestChangeCursor();
  let pumping = false;
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  function subKey(s: Subscription): string {
    return `${s.view}:${s.sessionId ?? ""}:${s.runId ?? ""}`;
  }

  function matches(sub: Subscription, runId: string, span?: SpanRow): boolean {
    if (sub.view === "index") return true;
    if (sub.view === "run") return sub.runId === runId;
    // Session view: match by the span's session when we have it; event-only
    // deltas resolve their span's run root lazily below.
    if (span?.sessionId) return span.sessionId === sub.sessionId;
    const snapshot = store.getSpan(`${runId}:turn`);
    return snapshot?.sessionId === sub.sessionId;
  }

  function ensurePolling() {
    if (pollHandle || subscriptions.size === 0) return;
    pollHandle = setInterval(() => pump(), POLL_INTERVAL_MS);
  }

  function stopPollingIfIdle() {
    if (pollHandle && subscriptions.size === 0) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  function toWireSpan(span: SpanRow): ActivitySpan {
    return {
      spanId: span.spanId,
      runId: span.runId,
      parentSpanId: span.parentSpanId ?? undefined,
      name: span.name,
      kind: span.kind,
      origin: span.origin,
      sessionId: span.sessionId ?? undefined,
      jobName: span.jobName ?? undefined,
      startedAt: span.startedAt,
      waitUntil: span.waitUntil ?? undefined,
      endedAt: span.endedAt ?? undefined,
      outcome: span.outcome ?? undefined,
      outcomeReason: span.outcomeReason ?? undefined,
      usage: hasUsage(span) ? { ...span.usage } : undefined,
      attrs: Object.keys(span.attrs).length > 0 ? span.attrs : undefined,
    };
  }

  function toWireEvent(event: SpanEventRow): ActivitySpanEvent {
    return {
      spanId: event.spanId,
      eventIndex: event.eventIndex,
      ts: event.ts,
      eventType: event.eventType,
      payload: event.payload,
      ...(event.truncated ? { truncated: true } : {}),
    };
  }

  function deltaFrame(change: ActivityChange): ServerActivityDelta {
    return change.kind === "span"
      ? { type: "activity_delta", runId: change.runId, seq: change.seq, span: toWireSpan(change.span) }
      : {
          type: "activity_delta",
          runId: change.runId,
          seq: change.seq,
          event: toWireEvent(change.event),
        };
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      // Nobody listening: skip the changes entirely, but keep the cursor at
      // the log's head — otherwise the first subscriber's pump would replay
      // history its snapshot already carries (harmless under the client's
      // seq-discard rule, but pure waste). Side effects that must see every
      // change (the notifier) keep their OWN cursor.
      if (subscriptions.size === 0) {
        cursor = store.latestChangeCursor();
        return;
      }
      for (;;) {
        const changes = store.changesSince(cursor, 200);
        if (changes.length === 0) break;
        for (const change of changes) {
          cursor = change.changeId;
          const span = change.kind === "span" ? changeSpanRow(change) : undefined;
          for (const [ws, subs] of subscriptions) {
            if (subs.some((s) => matches(s, change.runId, span))) {
              sendTo(ws, deltaFrame(change));
            }
          }
        }
        if (changes.length < 200) break;
      }
    } catch (err) {
      log?.emit({
        severityText: "WARN",
        body: "activity pump failed",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      pumping = false;
    }
  }

  function changeSpanRow(change: ActivityChange): SpanRow | undefined {
    return change.kind === "span" ? change.span : undefined;
  }

  function sendSnapshot(ws: WSContext, sub: Subscription): void {
    let spans: SpanRow[] = [];
    let events: SpanEventRow[] = [];
    const highWater: Record<string, number> = {};

    if (sub.view === "run" && sub.runId) {
      const snap = store.snapshotRun(sub.runId);
      if (snap) {
        spans = snap.spans;
        events = snap.events;
        highWater[snap.runId] = snap.highWaterSeq;
        // No pump-cursor rewind: the pump cursor can only LAG the snapshot
        // read (it never runs ahead of the DB), so unpumped changes are
        // already inside this snapshot's high-water and the client's
        // seq-discard rule absorbs them when the pump catches up.
      }
    } else if (sub.view === "session" && sub.sessionId) {
      for (const root of store.openRootSpans()) {
        if (root.sessionId !== sub.sessionId) continue;
        const snap = store.snapshotRun(root.runId);
        if (!snap) continue;
        spans = spans.concat(snap.spans);
        events = events.concat(snap.events);
        highWater[snap.runId] = snap.highWaterSeq;
      }
    } else {
      // Index view: open roots only — history is the REST activity API's job.
      const roots = store.openRootSpans();
      for (const root of roots) {
        const hi = store.snapshotRun(root.runId);
        if (!hi) continue;
        spans.push(root);
        highWater[root.runId] = hi.highWaterSeq;
      }
    }

    const base: Omit<ServerActivitySnapshot, "spans" | "events"> = {
      type: "activity_snapshot",
      view: sub.view,
      ...(sub.sessionId ? { sessionId: sub.sessionId } : {}),
      ...(sub.runId ? { runId: sub.runId } : {}),
      highWaterSeq: highWater,
    };

    // Chunk: spans + first event batch, then append frames for the rest.
    sendTo(ws, { ...base, spans: spans.map(toWireSpan), events: events.slice(0, SNAPSHOT_EVENT_CHUNK).map(toWireEvent) });
    for (let i = SNAPSHOT_EVENT_CHUNK; i < events.length; i += SNAPSHOT_EVENT_CHUNK) {
      sendTo(ws, {
        ...base,
        spans: [],
        events: events.slice(i, i + SNAPSHOT_EVENT_CHUNK).map(toWireEvent),
        append: true,
      });
    }
  }

  return {
    handleSubscribe(ws, msg) {
      const sub: Subscription = {
        view: msg.view,
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
        ...(msg.runId ? { runId: msg.runId } : {}),
      };
      const list = subscriptions.get(ws) ?? [];
      if (!list.some((s) => subKey(s) === subKey(sub))) list.push(sub);
      subscriptions.set(ws, list);
      ensurePolling();
      try {
        sendSnapshot(ws, sub);
      } catch (err) {
        log?.emit({
          severityText: "WARN",
          body: "activity snapshot failed",
          attributes: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    },

    handleUnsubscribe(ws, msg) {
      const list = subscriptions.get(ws);
      if (!list) return;
      const key = subKey({
        view: msg.view,
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
        ...(msg.runId ? { runId: msg.runId } : {}),
      });
      const remaining = list.filter((s) => subKey(s) !== key);
      if (remaining.length > 0) subscriptions.set(ws, remaining);
      else subscriptions.delete(ws);
      stopPollingIfIdle();
    },

    dropConnection(ws) {
      subscriptions.delete(ws);
      stopPollingIfIdle();
    },

    pump,

    isWatched(scope) {
      for (const subs of subscriptions.values()) {
        for (const s of subs) {
          if (s.view === "index") return true;
          if (scope.runId && s.view === "run" && s.runId === scope.runId) return true;
          if (scope.sessionId && s.view === "session" && s.sessionId === scope.sessionId)
            return true;
        }
      }
      return false;
    },

    subscriptionCount() {
      let n = 0;
      for (const subs of subscriptions.values()) n += subs.length;
      return n;
    },

    close() {
      if (pollHandle) clearInterval(pollHandle);
      pollHandle = null;
      subscriptions.clear();
    },
  };
}

function hasUsage(span: SpanRow): boolean {
  const u = span.usage;
  return (
    u.inputTokens !== undefined ||
    u.outputTokens !== undefined ||
    u.cacheReadTokens !== undefined ||
    u.cacheCreationTokens !== undefined ||
    u.costUsd !== undefined ||
    u.model !== undefined
  );
}
