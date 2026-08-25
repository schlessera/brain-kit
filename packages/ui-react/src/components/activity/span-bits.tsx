import { useShallow } from "zustand/react/shallow";
import { isFailureOutcome, SPAN_TOOL_NAME_PREFIX } from "@schlessera/brain-ui-sdk/protocol";
import type { ActivitySpan, ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";

import { useActivityStore, payloadEventsFor } from "../../stores/activity-store.js";
import { cn } from "../../lib/utils.js";
import { getToolLabel } from "../chat/tool-views.js";

/**
 * THE status dot for activity spans — one outcome→color mapping so every
 * surface (timeline rows, drill-in, activity index) agrees on what a color
 * means: running pulses primary, success is accent, failures (per
 * `isFailureOutcome`) and denied are destructive, cancelled is muted.
 */
export function SpanStatusDot({
  span,
  outcome,
  running,
  className,
}: {
  span?: ActivitySpan;
  /** Alternative to `span` when only the outcome is at hand. */
  outcome?: ActivitySpanOutcome | string | null;
  running?: boolean;
  /** Size/position overrides; defaults to h-1.5 w-1.5. */
  className?: string;
}) {
  const resolved = span ? span.outcome : outcome;
  const isRunning = running ?? (span !== undefined && span.outcome === undefined);
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        isRunning
          ? "animate-pulse bg-primary"
          : resolved === "success"
            ? "bg-accent"
            : isFailureOutcome(resolved) || resolved === "denied"
              ? "bg-destructive"
              : "bg-muted-foreground",
        className
      )}
    />
  );
}

/**
 * Display label for a span. Prefers the server-lifted `toolName`; root spans
 * label by kind (a turn or cron root is not a tool call); the last resort
 * un-parses the `execute_tool` naming convention for spans recorded before
 * the field existed.
 */
export function spanToolLabel(span: ActivitySpan): string {
  if (span.toolName) return getToolLabel(span.toolName);
  if (span.kind === "turn") return "Turn";
  if (span.kind === "cron") return span.jobName ?? span.name;
  return getToolLabel(
    span.name.startsWith(SPAN_TOOL_NAME_PREFIX)
      ? span.name.slice(SPAN_TOOL_NAME_PREFIX.length)
      : span.name
  );
}

/**
 * The recorded input/output of one tool span, expanded under its row — the
 * ONE payload renderer shared by the subagent drill-in and the run detail.
 * Mounted only while expanded (collapsed rows never subscribe). A span with
 * no payload events (recorded before capture shipped) states so instead of
 * offering an empty block (AE7); a payload clipped at persist time carries
 * the wire `truncated` flag, rendered as a hint line under the block.
 */
export function SpanPayload({ spanId }: { spanId: string }) {
  const events = useActivityStore(useShallow((s) => payloadEventsFor(s, spanId)));
  if (events.length === 0) {
    return (
      <p className="px-2 py-1 text-[11px] text-muted-foreground/60">
        No payload recorded for this run.
      </p>
    );
  }
  return (
    <div className="space-y-1.5 px-2 py-1">
      {events.map((event) => (
        <div key={`${event.spanId}:${event.eventIndex}`}>
          <div className="mb-0.5 text-[10px] uppercase text-muted-foreground/60">
            {event.eventType === "tool_input" ? "Input" : "Output"}
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-muted-foreground">
            {typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}
          </pre>
          {event.truncated && (
            <p className="mt-0.5 text-[10px] italic text-muted-foreground/60">… truncated</p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * THE effective-cost glyph — one three-state rule so no surface ever renders
 * an unknown cost as $0.00 (AE3): absent/NULL is "—" (we don't know), 0 is
 * "free" (we know — subscription-billed or genuinely zero), positive is
 * dollars, "~"-prefixed when computed from estimated rates. Sub-cent costs
 * floor at "<$0.01" rather than rounding down to a zero look-alike.
 */
export function formatEffectiveCost(
  costUsd: number | null | undefined,
  estimate?: boolean
): string {
  if (costUsd === null || costUsd === undefined) return "—";
  if (costUsd === 0) return "free";
  const amount = costUsd < 0.005 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
  return estimate ? `~${amount}` : amount;
}

/**
 * An aggregate's effective-cost sum. Sums exclude unknown-cost runs, so a
 * nonzero `unpricedRuns` makes the number a floor ("≥ $X"), never a total.
 */
export function formatAggregateCost(effectiveUsd: number, unpricedRuns: number): string {
  const amount = `$${effectiveUsd.toFixed(2)}`;
  return unpricedRuns > 0 ? `≥ ${amount}` : amount;
}

/**
 * The digest card's cost clause (no leading separator), effective-only, or
 * null for "say nothing". A digest persisted before pricing shipped carries
 * neither new field and keeps its old list-cost clause.
 */
export function digestCostClause(digest: {
  costUsd: number;
  effectiveCostUsd?: number;
  unpricedRuns?: number;
}): string | null {
  if (digest.effectiveCostUsd === undefined) {
    return digest.costUsd > 0 ? `$${digest.costUsd.toFixed(2)} spent` : null;
  }
  const unpriced = digest.unpricedRuns ?? 0;
  const qualifier = unpriced > 0 ? ` (${unpriced} unpriced)` : "";
  if (digest.effectiveCostUsd > 0) {
    return `${formatAggregateCost(digest.effectiveCostUsd, unpriced)} spent${qualifier}`;
  }
  // Known-zero spend: nothing to add up, but the unknowns still get named.
  if (unpriced > 0) return `${unpriced} unpriced`;
  return "free";
}

/** The "9+" unread-count bubble shared by the rail and the tab bar. Hidden at 0. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-white",
        className
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}
