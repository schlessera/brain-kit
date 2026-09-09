import type { ActivitySpan, ActivitySpanEvent } from "@schlessera/brain-ui-sdk/protocol";
import type { ActivityState, MirrorMaps } from "./activity-store-types.js";

/** Bound on the mirror: how many TERMINAL runs stay held. Live runs never count. */
const MAX_TERMINAL_RUNS = 50;

export function rootSpanOf(byId: Record<string, ActivitySpan>): ActivitySpan | undefined {
  return Object.values(byId).find((span) => span.parentSpanId === undefined);
}

/** Drop a whole run from the mirror — spans, events, high-water, reverse index. */
export function evictRun(maps: MirrorMaps, runId: string): void {
  for (const spanId of Object.keys(maps.spans[runId] ?? {})) {
    delete maps.events[spanId];
    delete maps.spanRun[spanId];
  }
  delete maps.spans[runId];
  delete maps.highWater[runId];
  delete maps.deltaSeq[runId];
}

/**
 * Enforce the terminal-run bound in place. Returns whether anything was
 * evicted. Runs whose root span is still open (or unknown) are never touched.
 */
export function pruneTerminalRuns(maps: MirrorMaps): boolean {
  const terminal: Array<{ runId: string; startedAt: number }> = [];
  for (const [runId, byId] of Object.entries(maps.spans)) {
    const root = rootSpanOf(byId);
    if (root && root.outcome !== undefined) {
      terminal.push({ runId, startedAt: root.startedAt });
    }
  }
  if (terminal.length <= MAX_TERMINAL_RUNS) return false;
  terminal.sort((a, b) => a.startedAt - b.startedAt);
  for (const { runId } of terminal.slice(0, terminal.length - MAX_TERMINAL_RUNS)) {
    evictRun(maps, runId);
  }
  return true;
}

export function insertEvent(
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
  return Object.values(byId).sort(
    (a, b) =>
      (a.parentSpanId ? 1 : 0) - (b.parentSpanId ? 1 : 0) || a.startedAt - b.startedAt
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

/** Stable empty result for `eventsFor` — a fresh `[]` per call would defeat
 *  reference-equality checks in zustand selectors. */
export const EMPTY_EVENTS: ActivitySpanEvent[] = Object.freeze(
  [] as ActivitySpanEvent[]
) as ActivitySpanEvent[];

/** Ordered events of a span; the shared frozen empty array when none. */
export function eventsFor(state: ActivityState, spanId: string): ActivitySpanEvent[] {
  return state.events[spanId] ?? EMPTY_EVENTS;
}

/** Payload event types the tool expander owns — every OTHER type belongs to
 *  the narrative stream (`narrativeEventsFor`) so nothing recorded is
 *  rendered nowhere. */
const TOOL_PAYLOAD_TYPES = new Set(["tool_input", "tool_output"]);

/**
 * The recorded input/output payload events of a tool span (AE7). Returns a
 * fresh array per call — subscribe through `useShallow` (like `childSpans`).
 */
export function payloadEventsFor(state: ActivityState, spanId: string): ActivitySpanEvent[] {
  const events = state.events[spanId];
  if (!events) return EMPTY_EVENTS;
  const payloads = events.filter((e) => TOOL_PAYLOAD_TYPES.has(e.eventType));
  return payloads.length > 0 ? payloads : EMPTY_EVENTS;
}

/**
 * Everything recorded against a span that is NOT a tool input/output payload:
 * transcript excerpts, job output, and any span-sink event type a producer
 * invents. Rendered as the span's narrative so an unknown type degrades to a
 * labelled block rather than to invisibility.
 */
export function narrativeEventsFor(
  state: ActivityState,
  spanId: string
): ActivitySpanEvent[] {
  const events = state.events[spanId];
  if (!events) return EMPTY_EVENTS;
  const rest = events.filter((e) => !TOOL_PAYLOAD_TYPES.has(e.eventType));
  return rest.length > 0 ? rest : EMPTY_EVENTS;
}

/** Every event recorded under a run, ordered by time — the run detail's
 *  narrative stream and the raw-trace dump both read through this. */
export function runEvents(state: ActivityState, runId: string): ActivitySpanEvent[] {
  const byId = state.spans[runId];
  if (!byId) return EMPTY_EVENTS;
  const out: ActivitySpanEvent[] = [];
  for (const spanId of Object.keys(byId)) {
    const events = state.events[spanId];
    if (events) out.push(...events);
  }
  if (out.length === 0) return EMPTY_EVENTS;
  return out.sort((a, b) => a.ts - b.ts || a.eventIndex - b.eventIndex);
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
