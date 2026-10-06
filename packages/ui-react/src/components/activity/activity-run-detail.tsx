import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isFailureOutcome, type ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
import { TraceSteps, type TraceStep } from "@schlessera/brain-ui-kit";

import { ApiRequestError, type ActivityRunRollup } from "../../lib/api-client.js";
import {
  useActivityStore,
  narrativeEventsFor,
  runEvents,
  runSpans,
} from "../../stores/activity-store.js";
import { useBrainApi } from "../../root-context.js";
import { cn } from "../../lib/utils.js";
import { CopyButton } from "../chat/copy-button.js";
import { formatDuration, formatRelativeTime } from "../chat/tool-views.js";
import {
  SpanEventBlock,
  SpanPayload,
  SpanStatusDot,
  formatEffectiveCost,
  formatSpanUsage,
  spanToolLabel,
} from "./span-bits.js";
import { RunRollupReceipt } from "./activity-views.js";
import { ReportButton, reportButtonName, type ActivityReportRequest } from "./activity-report.js";
import { rollupReportRun, type ReportRecord, type ReportRun } from "../../lib/activity-report.js";

/**
 * Chat-less run detail (cron runs; pruned runs show their rollup) — the full
 * view of one run: its rollup header, the span tree with per-span usage,
 * attributes and recorded events, and a raw-trace escape hatch for anything
 * the rendered view does not have an opinion about.
 *
 * `embedded` is the D4 desktop pane: the Actions list sits beside this view
 * from `laptop:` up, so the back chevron only renders below that width, and
 * from `wide:` the span tree moves out to the page's evidence rail
 * (`RunTraceSteps`) — the same store slice, fetched once here.
 */
export function RunDetail({
  runId,
  onBack,
  embedded = false,
  onReport,
}: {
  runId: string;
  onBack: () => void;
  embedded?: boolean;
  /** Send bug report, offered only while the run's outcome is a failure (#598). */
  onReport?: (request: ActivityReportRequest) => void;
}) {
  const api = useBrainApi();
  const streamed = useActivityStore(useShallow((s) => runSpans(s, runId)));
  const events = useActivityStore(useShallow((s) => runEvents(s, runId)));
  const applySnapshot = useActivityStore((s) => s.applySnapshot);
  const [pruned, setPruned] = useState<object | null>(null);
  const [rollup, setRollup] = useState<ActivityRunRollup | null>(null);
  // "not-found" is a 404; any other failure is a record this view could not read.
  const [missing, setMissing] = useState<false | "not-found" | "unreadable">(false);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setPruned(null);
    setRollup(null);
    setMissing(false);
    setRawOpen(false);
    api
      // Payload bodies are excluded from run detail by default; this view's
      // rows expand to them, so opt in.
      .activityRun(runId, { includePayloads: true })
      .then((detail) => {
        if (!active) return;
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
      .catch((err) => {
        if (active) setMissing(err instanceof ApiRequestError && err.status === 404 ? "not-found" : "unreadable");
      });
    return () => {
      active = false;
    };
  }, [runId, applySnapshot, api]);

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
  // The live stream's outcome wins over the fetched rollup: a run that fails
  // while this view is open offers the report without a reload.
  const outcome = root?.outcome ?? rollup?.outcome ?? null;
  const failed = isFailureOutcome(outcome);
  const reportRun: ReportRun | null = !failed ? null : rollup
    ? { ...rollupReportRun(rollup, Boolean(pruned)), outcome }
    : root
      ? { origin: root.origin, outcome, durationMs: root.endedAt !== undefined ? root.endedAt - root.startedAt : null,
          failureReason: root.outcomeReason ?? null, jobName: root.jobName ?? null, detailPruned: false }
      : null;
  // Only settled facts are handed over. The mirror can lag the record (a
  // snapshot older than a streamed delta is refused, and children may not be
  // streamed at all), so for a retained run the sheet reads the record itself
  // when it opens, after the failure, rather than freezing a partial mirror.
  const record: ReportRecord | undefined = pruned ? { state: "pruned" } : missing === "not-found" ? { state: "not-found" } : undefined;
  // Announce once, and only for a run this view watched fail.
  // Reset during render, before this render's observation, so a run already
  // running on the first render still counts as watched.
  const sawRunning = useRef(false);
  const watching = useRef(runId);
  if (watching.current !== runId) {
    watching.current = runId;
    sawRunning.current = false;
  }
  const [announced, setAnnounced] = useState(false);
  if (!failed && outcome === null && (root || rollup)) sawRunning.current = true;
  useEffect(() => { setAnnounced(false); }, [runId]);
  useEffect(() => {
    if (failed && sawRunning.current && !announced) setAnnounced(true);
  }, [failed, announced]);

  // Serialised once per render and only while open: the <pre> shows it and
  // the copy button hands over the same string.
  const rawTrace = rawOpen ? JSON.stringify({ runId, rollup, spans: streamed, events }, null, 2) : "";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground",
            embedded && "laptop:hidden"
          )}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium outline-none" tabIndex={-1} data-run-detail-heading="" data-destination-heading="">{title}</h1>
          <p className="truncate font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/60">
            {runId}
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-1 p-4">
        {missing && <p className="text-xs text-muted-foreground">Unknown run.</p>}
        {rollup && (
          <RunRollupReceipt
            origin={rollup.origin}
            outcome={rollup.outcome}
            when={formatRelativeTime(rollup.startedAt)}
            duration={rollup.durationMs !== null ? formatDuration(rollup.durationMs) : null}
            listCost={formatEffectiveCost(rollup.costUsd)}
            effectiveCost={formatEffectiveCost(rollup.effectiveCostUsd, rollup.pricingEstimate, rollup.billingMode)}
            billing={rollup.billingMode ? (rollup.billingMode === "api" ? "API billed" : "subscription billed") : null}
            estimated={Boolean(rollup.pricingEstimate)}
            usage={totalUsage}
            failureReason={rollup.failureReason}
          />
        )}
        {reportRun && onReport && (
          <div className="pb-3 pt-1">
            <ReportButton
              runId={runId}
              placement="detail"
              name={reportButtonName(title, outcome!, formatRelativeTime(rollup?.startedAt ?? root?.startedAt ?? Date.now()))}
              onClick={() => onReport({ runId, run: reportRun, record, from: "detail" })}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">Opens a review first. Nothing is sent until you choose to.</p>
          </div>
        )}
        <p role="status" className="bk-sr-only">{announced ? "Run failed. Send bug report is available." : ""}</p>
        {pruned && (
          <div className="rounded-lg border border-border-subtle bg-surface p-3 text-xs text-muted-foreground">
            Trace pruned · this run's rollup is kept.
            <div className="group/copy relative mt-2">
              <pre className="overflow-x-auto pr-9 text-[11px]">{JSON.stringify(pruned, null, 2)}</pre>
              <CopyButton label="Copy rollup" getText={() => JSON.stringify(pruned, null, 2)} />
            </div>
          </div>
        )}
        <div className={cn("space-y-1", embedded && "wide:hidden")}>
          {streamed.map((span) => (
            <DetailSpanRow key={span.spanId} span={span} depth={depthOf(span, streamed)} />
          ))}
        </div>
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
              <div className="group/copy relative mt-1">
                <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border-subtle bg-surface p-2 pr-9 font-[family-name:var(--font-mono)] text-[10px] leading-relaxed text-muted-foreground">
                  {rawTrace}
                </pre>
                <CopyButton label="Copy raw trace" getText={() => rawTrace} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The run's trace as the kit's list timeline, for the D4 evidence rail. Reads
 * the store slice `RunDetail` filled — no second fetch — and stays a record:
 * the rail's steps do not expand, the escape hatch for that is the detail's
 * raw trace.
 */
export function RunTraceSteps({ runId }: { runId: string }) {
  const streamed = useActivityStore(useShallow((s) => runSpans(s, runId)));
  const steps = useMemo<TraceStep[]>(
    () =>
      streamed.map((span) => ({
        state: traceState(span),
        tool: spanToolLabel(span),
        text: span.outcomeReason ?? (span.kind !== "tool" ? span.kind : undefined),
        time:
          span.endedAt !== undefined
            ? formatDuration(span.endedAt - (span.waitUntil ?? span.startedAt))
            : undefined,
      })),
    [streamed]
  );
  if (steps.length === 0) {
    return <p className="text-xs text-muted-foreground/70">No spans recorded for this run.</p>;
  }
  return <TraceSteps variant="list" steps={steps} />;
}

/** Same boundary `toolState` draws for the run cards: open is active, a
 * failure outcome is failed and any other non-success outcome (cancelled,
 * skipped) is skipped. */
function traceState(span: ActivitySpan): TraceStep["state"] {
  if (span.outcome === undefined || span.outcome === null) return "active";
  if (span.outcome === "success") return "done";
  return isFailureOutcome(span.outcome) ? "failed" : "skipped";
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
