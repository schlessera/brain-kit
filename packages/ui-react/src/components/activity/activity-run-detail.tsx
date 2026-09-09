import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isFailureOutcome, type ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import { api, type ActivityRunRollup } from "../../lib/api-client.js";
import {
  useActivityStore,
  narrativeEventsFor,
  runEvents,
  runSpans,
} from "../../stores/activity-store.js";
import { cn } from "../../lib/utils.js";
import { formatDuration, formatRelativeTime } from "../chat/tool-views.js";
import {
  SpanEventBlock,
  SpanPayload,
  SpanStatusDot,
  formatEffectiveCost,
  formatSpanUsage,
  spanToolLabel,
} from "./span-bits.js";

/**
 * Chat-less run detail (cron runs; pruned runs show their rollup) — the full
 * view of one run: its rollup header, the span tree with per-span usage,
 * attributes and recorded events, and a raw-trace escape hatch for anything
 * the rendered view does not have an opinion about.
 */
export function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const streamed = useActivityStore(useShallow((s) => runSpans(s, runId)));
  const events = useActivityStore(useShallow((s) => runEvents(s, runId)));
  const applySnapshot = useActivityStore((s) => s.applySnapshot);
  const [pruned, setPruned] = useState<object | null>(null);
  const [rollup, setRollup] = useState<ActivityRunRollup | null>(null);
  const [missing, setMissing] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    api
      // Payload bodies are excluded from run detail by default; this view's
      // rows expand to them, so opt in.
      .activityRun(runId, { includePayloads: true })
      .then((detail) => {
        if (detail.rollup) setRollup(detail.rollup);
        if (detail.detailPruned) {
          setPruned(detail.rollup ?? {});
        } else if (detail.spans) {
          applySnapshot({
            type: "activity_snapshot",
            view: "run",
            runId,
            spans: detail.spans,
            events: detail.events ?? [],
            highWaterSeq: { [runId]: detail.highWaterSeq ?? 0 },
          });
        }
      })
      .catch(() => setMissing(true));
  }, [runId, applySnapshot]);

  const root = streamed.find((s) => !s.parentSpanId);
  const title = rollup?.jobName ?? rollup?.name ?? (root ? spanToolLabel(root) : runId);
  // The root carries the run's usage for backend-recorded turns; a run whose
  // usage only exists on children (the span-sink shape) sums them instead.
  // Never both, so nothing is double-counted.
  const totalUsage = useMemo(() => {
    if (root?.usage) return formatSpanUsage(root);
    const children = streamed.filter((s) => s.parentSpanId && s.usage);
    if (children.length === 0) return null;
    const sum = children.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + (s.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (s.usage?.outputTokens ?? 0),
        cacheReadTokens: acc.cacheReadTokens + (s.usage?.cacheReadTokens ?? 0),
        cacheCreationTokens: acc.cacheCreationTokens + (s.usage?.cacheCreationTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    );
    return formatSpanUsage({ ...children[0]!, usage: { ...sum, model: undefined } });
  }, [root, streamed]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{title}</h1>
          <p className="truncate font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/60">
            {runId}
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-1 p-4">
        {missing && <p className="text-xs text-muted-foreground">Unknown run.</p>}
        {rollup && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[11px] text-muted-foreground">
            <span className="text-foreground/80">{rollup.origin}</span>
            {rollup.outcome && (
              <span className={cn(isFailureOutcome(rollup.outcome) && "text-destructive")}>
                {rollup.outcome}
              </span>
            )}
            <span>{formatRelativeTime(rollup.startedAt)}</span>
            {rollup.durationMs !== null && <span>{formatDuration(rollup.durationMs)}</span>}
            <span>
              list{" "}
              <span className="font-[family-name:var(--font-mono)] text-foreground/80">
                {formatEffectiveCost(rollup.costUsd)}
              </span>
            </span>
            <span>
              effective{" "}
              <span className="font-[family-name:var(--font-mono)] text-foreground/80">
                {formatEffectiveCost(
                  rollup.effectiveCostUsd,
                  rollup.pricingEstimate,
                  rollup.billingMode
                )}
              </span>
            </span>
            {rollup.billingMode && (
              <span>{rollup.billingMode === "api" ? "API billed" : "subscription billed"}</span>
            )}
            {rollup.pricingEstimate && <span>~ estimated rates</span>}
            {totalUsage && (
              <span className="font-[family-name:var(--font-mono)] text-foreground/80">
                {totalUsage}
              </span>
            )}
            {rollup.failureReason && (
              <span className="w-full whitespace-pre-wrap break-words pt-1 text-destructive/80">
                {rollup.failureReason}
              </span>
            )}
          </div>
        )}
        {pruned && (
          <div className="rounded-lg border border-border-subtle bg-surface p-3 text-xs text-muted-foreground">
            Detail pruned — only the rollup remains.
            <pre className="mt-2 overflow-x-auto text-[11px]">{JSON.stringify(pruned, null, 2)}</pre>
          </div>
        )}
        {streamed.map((span) => (
          <DetailSpanRow key={span.spanId} span={span} depth={depthOf(span, streamed)} />
        ))}
        {!pruned && !missing && streamed.length === 0 && (
          <p className="text-xs text-muted-foreground">No spans recorded for this run.</p>
        )}
        {/* The escape hatch: whatever the rendered tree has no opinion about
            is still readable here, so the view is never LESS than the trace. */}
        {streamed.length > 0 && (
          <div className="pt-3">
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn("h-3 w-3 transition-transform", rawOpen && "rotate-90")}
              />
              Raw trace
            </button>
            {rawOpen && (
              <pre className="mt-1 max-h-[60vh] overflow-auto rounded-lg border border-border-subtle bg-surface p-2 font-[family-name:var(--font-mono)] text-[10px] leading-relaxed text-muted-foreground">
                {JSON.stringify({ runId, rollup, spans: streamed, events }, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One span tree row. EVERY span expands — a tool span to its recorded payload
 * (AE7), any span to its usage, attributes and recorded events. The uniform
 * affordance is the point: a cron root or a turn root used to be a dead dot
 * with a duration, which is strictly less than the trace it was summarizing.
 */
function DetailSpanRow({ span, depth }: { span: ActivitySpan; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const usage = formatSpanUsage(span);
  // Approval wait is not execution — same boundary the subagent drill-in uses.
  const duration =
    span.endedAt !== undefined
      ? formatDuration(span.endedAt - (span.waitUntil ?? span.startedAt))
      : "…";
  return (
    <div style={{ paddingLeft: `${depth * 16}px` }}>
      <div
        className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        <SpanStatusDot span={span} />
        <span className="truncate font-[family-name:var(--font-mono)]">
          {spanToolLabel(span)}
        </span>
        {span.kind !== "tool" && (
          <span className="shrink-0 rounded bg-surface-raised px-1 text-[9px] uppercase text-muted-foreground/70">
            {span.kind}
          </span>
        )}
        {span.outcome && span.outcome !== "success" && (
          <span className="text-[10px] uppercase">{span.outcome}</span>
        )}
        {span.outcomeReason && (
          <span className="truncate text-[10px] text-muted-foreground/60">
            {span.outcomeReason}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
          {usage && <span className="hidden sm:inline">{usage}</span>}
          <span>{duration}</span>
        </span>
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
      </div>
      {expanded && <DetailSpanBody span={span} usage={usage} />}
    </div>
  );
}

/** Everything recorded against one span, under its row. */
function DetailSpanBody({ span, usage }: { span: ActivitySpan; usage: string | null }) {
  const narrative = useActivityStore(useShallow((s) => narrativeEventsFor(s, span.spanId)));
  const attrs = Object.entries(span.attrs ?? {});
  return (
    <div className="mb-1 ml-1 space-y-1.5 border-l border-border-subtle pl-2 pt-1">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2 text-[10px] text-muted-foreground/70">
        <span>started {new Date(span.startedAt).toLocaleString()}</span>
        {span.waitUntil !== undefined && (
          <span>approval wait {formatDuration(span.waitUntil - span.startedAt)}</span>
        )}
        {usage && <span className="font-[family-name:var(--font-mono)]">{usage}</span>}
        {span.usage?.costUsd !== undefined && (
          <span className="font-[family-name:var(--font-mono)]">
            {formatEffectiveCost(span.usage.costUsd)} list
          </span>
        )}
      </div>
      {span.subagent?.summary && (
        <p className="px-2 text-[11px] text-muted-foreground">{span.subagent.summary}</p>
      )}
      {attrs.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 gap-y-0.5 px-2 text-[10px]">
          {attrs.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="truncate font-[family-name:var(--font-mono)] text-muted-foreground/60">
                {key}
              </dt>
              <dd className="min-w-0 break-words font-[family-name:var(--font-mono)] text-muted-foreground">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {narrative.length > 0 && (
        <div className="space-y-1.5 px-2">
          {narrative.map((event) => (
            <SpanEventBlock key={`${event.spanId}:${event.eventIndex}`} event={event} />
          ))}
        </div>
      )}
      {span.kind === "tool" && <SpanPayload spanId={span.spanId} />}
      {span.kind !== "tool" && narrative.length === 0 && attrs.length === 0 && (
        <p className="px-2 text-[11px] text-muted-foreground/60">
          Nothing else recorded for this step.
        </p>
      )}
    </div>
  );
}

function depthOf(span: ActivitySpan, all: ActivitySpan[]): number {
  let depth = 0;
  let current: ActivitySpan | undefined = span;
  while (current?.parentSpanId) {
    depth += 1;
    current = all.find((s) => s.spanId === current!.parentSpanId);
    if (depth > 6) break;
  }
  return depth;
}
