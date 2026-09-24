/**
 * The span-sink JSONL contract: how an agent-running cron step reports its
 * activity to the wrapper that records the run.
 *
 * The wrapper (the deployment's cron runner) exports a file path in
 * `BRAIN_ACTIVITY_SPAN_SINK`; the child process appends one JSON object per
 * line and never reads the file back. The wrapper ingests incrementally
 * (liveness) and once at exit (completeness), attaching everything under the
 * run's root span. No core call site emits this yet — the contract ships
 * first, fixture-verified, and producers arrive when core grows an agent
 * loop (see the plan's Deferred to Follow-Up Work).
 *
 * Line shapes (unknown fields ignored, malformed lines skipped and counted):
 *
 *   {"type":"span_start","spanId":"s1","name":"execute_tool Read","ts":123,
 *    "parentSpanId":"s0"?, "kind":"tool"?}
 *   {"type":"span_end","spanId":"s1","outcome":"success","ts":124,
 *    "reason":"..."?, "usage":{"inputTokens":1,...}?}
 *   {"type":"event","spanId":"s1","eventType":"text","payload":...,"ts":125}
 */
import { readFileSync } from "fs";

import { SPAN_OUTCOMES, type ActivityStore, type SpanOutcome, type SpanUsage } from "./store.js";

export interface SpanSinkContext {
  /** The run every ingested span belongs to. */
  runId: string;
  /** Parent for lines that name none — the cron root span. */
  rootSpanId: string;
  jobName?: string;
}

export interface SpanSinkResult {
  /** Byte offset consumed so far — pass back on the next incremental call. */
  offset: number;
  ingested: number;
  skipped: number;
}

/**
 * Ingest new complete lines from a span-sink file. Incremental: pass the
 * previous call's `offset`; a partial trailing line is left for next time.
 * A missing file is an empty result, not an error — the child may simply
 * never have emitted.
 */
export function ingestSpanSink(
  store: ActivityStore,
  path: string,
  context: SpanSinkContext,
  offset = 0
): SpanSinkResult {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { offset, ingested: 0, skipped: 0 };
  }
  if (text.length <= offset) return { offset, ingested: 0, skipped: 0 };

  const chunk = text.slice(offset);
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return { offset, ingested: 0, skipped: 0 };
  const complete = chunk.slice(0, lastNewline);
  const consumed = offset + lastNewline + 1;

  let ingested = 0;
  let skipped = 0;
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    if (applyLine(store, line, context)) ingested++;
    else skipped++;
  }
  return { offset: consumed, ingested, skipped };
}

function applyLine(store: ActivityStore, line: string, context: SpanSinkContext): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const spanId = str(parsed.spanId);
  if (!spanId) return false;
  // Sink span ids are namespaced by run so two runs' children can never
  // collide in the shared store.
  const scopedId = `${context.runId}:${spanId}`;

  try {
    switch (parsed.type) {
      case "span_start": {
        const name = str(parsed.name);
        if (!name) return false;
        const parent = str(parsed.parentSpanId);
        store.startSpan({
          spanId: scopedId,
          runId: context.runId,
          parentSpanId: parent ? `${context.runId}:${parent}` : context.rootSpanId,
          name,
          kind: parsed.kind === "subagent" ? "subagent" : "tool",
          origin: "cron",
          jobName: context.jobName,
          startedAt: num(parsed.ts),
        });
        return true;
      }
      case "span_end": {
        const outcome = str(parsed.outcome);
        if (!outcome || !(SPAN_OUTCOMES as readonly string[]).includes(outcome)) return false;
        return store.endSpan(scopedId, {
          outcome: outcome as SpanOutcome,
          reason: str(parsed.reason),
          endedAt: num(parsed.ts),
          usage: usageOf(parsed.usage),
        });
      }
      case "event": {
        const eventType = str(parsed.eventType);
        if (!eventType) return false;
        return store.appendEvent(scopedId, eventType, parsed.payload, num(parsed.ts)) !== null;
      }
      default:
        return false;
    }
  } catch {
    // A duplicate span_start (replayed line) or similar must not abort the
    // whole ingest.
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function usageOf(v: unknown): SpanUsage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const u = v as Record<string, unknown>;
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheCreationTokens: num(u.cacheCreationTokens),
    costUsd: num(u.costUsd),
    model: str(u.model),
  };
}
