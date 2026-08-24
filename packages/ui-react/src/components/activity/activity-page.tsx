import { useEffect, useMemo, useState } from "react";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Clock,
  RefreshCw,
  Timer,
} from "lucide-react";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import {
  api,
  type ActivityRollups,
  type ActivityRunSummary,
} from "../../lib/api-client.js";
import { sendClientMessage } from "../../hooks/use-websocket.js";
import { useActivityStore, runSpans } from "../../stores/activity-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { cn } from "../../lib/utils.js";
import { formatDuration, getToolLabel } from "../chat/tool-views.js";
import { PushToggle } from "./push-toggle.js";

/**
 * The Activity surface: an INDEX of all agent activity — live runs first,
 * then history — with cost/token rollups. Deliberately not a residence:
 * a session run deep-links back into its chat, a subagent into the drill-in
 * stack; only a cron run (which has no chat around it) details here.
 *
 * Live rows ride the index-view activity subscription while this surface is
 * open; history and rollups come from the REST activity API.
 */
export function ActivityPage() {
  const supported = useActivityStore((s) => s.supported);
  const liveSpans = useActivityStore((s) => s.spans);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const [runs, setRuns] = useState<{ live: ActivityRunSummary[]; history: ActivityRunSummary[] } | null>(null);
  const [rollups, setRollups] = useState<ActivityRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);

  const inbox = useActivityStore((s) => s.inbox);
  const loadInbox = useActivityStore((s) => s.loadInbox);
  const acknowledgeIntent = useActivityStore((s) => s.acknowledgeIntent);
  const acknowledgeAllIntents = useActivityStore((s) => s.acknowledgeAllIntents);

  const refresh = () => {
    api
      .activityRuns({ limit: 100 })
      .then(setRuns)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    api.activityRollups(7).then(setRollups).catch(() => {});
    void loadInbox();
  };

  useEffect(() => {
    refresh();
    if (supported) {
      sendClientMessage({ type: "activity_subscribe", view: "index" });
      return () => {
        sendClientMessage({ type: "activity_unsubscribe", view: "index" });
      };
    }
    return undefined;
  }, [supported]);

  // Live open roots from the stream override/extend the REST snapshot.
  const liveRoots = useMemo(() => {
    const roots: ActivitySpan[] = [];
    for (const byId of Object.values(liveSpans)) {
      for (const span of Object.values(byId)) {
        if (!span.parentSpanId && span.outcome === undefined) roots.push(span);
      }
    }
    return roots.sort((a, b) => b.startedAt - a.startedAt);
  }, [liveSpans]);

  const liveRunIds = new Set(liveRoots.map((r) => r.runId));
  const restLive = (runs?.live ?? []).filter((r) => !liveRunIds.has(r.runId));
  const history = (runs?.history ?? []).filter((r) => !liveRunIds.has(r.runId));

  function openRun(row: {
    runId: string;
    origin: string;
    sessionId?: string | null;
    running?: boolean;
  }) {
    if (row.origin === "session" && row.sessionId) {
      // Chat is the residence — a session run opens its session.
      setActiveSession(row.sessionId);
      setActiveView("chat");
      return;
    }
    setDetailRunId(row.runId);
  }

  if (detailRunId) {
    return <RunDetail runId={detailRunId} onBack={() => setDetailRunId(null)} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <ActivityIcon className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Activity</h1>
        <div className="ml-auto flex items-center gap-2">
          <PushToggle />
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          aria-label="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-6 p-4">
        {error && (
          <p className="text-xs text-destructive">Could not load activity: {error}</p>
        )}

        {inbox.length > 0 && (
          <section>
            <div className="mb-2 flex items-center">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Needs attention
              </h2>
              <button
                type="button"
                onClick={() => void acknowledgeAllIntents()}
                className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Dismiss all
              </button>
            </div>
            <div className="space-y-1">
              {inbox.map((intent) => (
                <div
                  key={intent.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
                    intent.kind === "failure"
                      ? "border-destructive/30 bg-destructive/5"
                      : "border-border-subtle bg-surface"
                  )}
                >
                  {intent.kind === "failure" ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  ) : intent.kind === "stuck" ? (
                    <Timer className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <ActivityIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    onClick={() => {
                      void acknowledgeIntent(intent.id);
                      setDetailRunId(intent.runId);
                    }}
                  >
                    {intent.title}
                  </button>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {relativeTime(intent.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void acknowledgeIntent(intent.id)}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {rollups && <RollupCards rollups={rollups} />}

        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Running now
          </h2>
          {liveRoots.length === 0 && restLive.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">Nothing is running.</p>
          ) : (
            <div className="space-y-1">
              {liveRoots.map((span) => (
                <LiveRow key={span.runId} span={span} onOpen={openRun} />
              ))}
              {restLive.map((run) => (
                <RunRow key={run.runId} run={run} onOpen={openRun} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            History
          </h2>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">No recorded runs yet.</p>
          ) : (
            <div className="space-y-1">
              {history.map((run) => (
                <RunRow key={run.runId} run={run} onOpen={openRun} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function RollupCards({ rollups }: { rollups: ActivityRollups }) {
  const today = rollups.days[0];
  const week = rollups.days.reduce(
    (acc, d) => ({
      runs: acc.runs + d.runs,
      failures: acc.failures + d.failures,
      costUsd: acc.costUsd + d.costUsd,
      tokens: acc.tokens + d.inputTokens + d.outputTokens,
    }),
    { runs: 0, failures: 0, costUsd: 0, tokens: 0 }
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatCard label="Runs today" value={String(today?.runs ?? 0)} />
      <StatCard
        label="Failures (7d)"
        value={String(week.failures)}
        alert={week.failures > 0}
      />
      <StatCard label="Spend (7d)" value={`$${week.costUsd.toFixed(2)}`} />
      <StatCard label="Tokens (7d)" value={compactTokens(week.tokens)} />
    </div>
  );
}

function StatCard({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-3">
      <div className={cn("text-lg font-semibold", alert && "text-destructive")}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function LiveRow({
  span,
  onOpen,
}: {
  span: ActivitySpan;
  onOpen: (row: { runId: string; origin: string; sessionId?: string | null }) => void;
}) {
  const children = useActivityStore((s) =>
    Object.values(s.spans[span.runId] ?? {}).filter((x) => x.parentSpanId)
  );
  const current = children.filter((c) => c.outcome === undefined).at(-1);
  const currentLabel = current
    ? getToolLabel(current.name.replace(/^execute_tool /, ""))
    : null;
  return (
    <button
      type="button"
      onClick={() => onOpen({ runId: span.runId, origin: span.origin, sessionId: span.sessionId })}
      className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-left text-xs transition-colors hover:bg-surface-raised"
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
      {span.origin === "cron" ? (
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate font-medium">
        {span.jobName ?? span.name}
      </span>
      {/* A span-only run (plain cron job) has no current step — name+elapsed
          is its whole live story. */}
      {currentLabel && (
        <span className="truncate text-muted-foreground">· {currentLabel}</span>
      )}
      <span className="ml-auto shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/60">
        {formatDuration(Date.now() - span.startedAt)}
      </span>
    </button>
  );
}

function RunRow({
  run,
  onOpen,
}: {
  run: ActivityRunSummary;
  onOpen: (row: ActivityRunSummary) => void;
}) {
  const failed =
    run.outcome === "error" || run.outcome === "timeout" || run.outcome === "interrupted";
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-surface-raised",
        failed && "border border-destructive/30 bg-destructive/5"
      )}
    >
      {run.origin === "cron" ? (
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{run.jobName ?? run.name}</span>
      {failed && <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />}
      {run.outcome && run.outcome !== "success" && (
        <span className={cn("text-[10px] uppercase", failed ? "text-destructive" : "text-muted-foreground")}>
          {run.outcome}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/60">
        {run.costUsd !== null && run.costUsd > 0 && <span>${run.costUsd.toFixed(2)}</span>}
        {run.durationMs !== null && (
          <span className="flex items-center gap-0.5">
            <Timer className="h-3 w-3" />
            {formatDuration(run.durationMs)}
          </span>
        )}
        <span>{relativeTime(run.startedAt)}</span>
      </span>
    </button>
  );
}

/** Chat-less run detail (cron runs; pruned runs show their rollup). */
function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const streamed = useActivityStore((s) => runSpans(s, runId));
  const applySnapshot = useActivityStore((s) => s.applySnapshot);
  const [pruned, setPruned] = useState<null | Record<string, unknown>>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api
      .activityRun(runId)
      .then((detail) => {
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
        <h1 className="truncate text-sm font-medium">{runId}</h1>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-1 p-4">
        {missing && <p className="text-xs text-muted-foreground">Unknown run.</p>}
        {pruned && (
          <div className="rounded-lg border border-border-subtle bg-surface p-3 text-xs text-muted-foreground">
            Detail pruned — only the rollup remains.
            <pre className="mt-2 overflow-x-auto text-[11px]">{JSON.stringify(pruned, null, 2)}</pre>
          </div>
        )}
        {streamed.map((span) => (
          <div
            key={span.spanId}
            className="flex items-center gap-2 text-xs text-muted-foreground"
            style={{ paddingLeft: `${depthOf(span, streamed) * 16}px` }}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                span.outcome === undefined && "animate-pulse bg-primary",
                span.outcome === "success" && "bg-accent",
                (span.outcome === "error" || span.outcome === "timeout") && "bg-destructive",
                (span.outcome === "cancelled" ||
                  span.outcome === "interrupted" ||
                  span.outcome === "denied") &&
                  "bg-muted-foreground"
              )}
            />
            <span className="truncate font-[family-name:var(--font-mono)]">
              {getToolLabel(span.name.replace(/^execute_tool /, ""))}
            </span>
            {span.outcome && span.outcome !== "success" && (
              <span className="text-[10px] uppercase">{span.outcome}</span>
            )}
            {span.outcomeReason && (
              <span className="truncate text-[10px] text-muted-foreground/60">
                {span.outcomeReason}
              </span>
            )}
            <span className="ml-auto shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
              {span.endedAt !== undefined
                ? formatDuration(span.endedAt - span.startedAt)
                : "…"}
            </span>
          </div>
        ))}
      </div>
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

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
