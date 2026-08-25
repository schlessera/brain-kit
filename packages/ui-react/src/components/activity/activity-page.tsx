import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  Clock,
  RefreshCw,
  Timer,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isFailureOutcome } from "@schlessera/brain-ui-sdk/protocol";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import {
  api,
  type ActivityIntent,
  type ActivityRollups,
  type ActivityRunRollup,
  type ActivityRunSummary,
} from "../../lib/api-client.js";
import { sendClientMessage } from "../../hooks/use-websocket.js";
import { useNow } from "../../hooks/use-now.js";
import { useActivityStore, runSpans } from "../../stores/activity-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { cn } from "../../lib/utils.js";
import {
  formatDuration,
  formatRelativeTime,
  formatTokenCount,
} from "../chat/tool-views.js";
import {
  SpanPayload,
  SpanStatusDot,
  formatAggregateCost,
  formatEffectiveCost,
  spanToolLabel,
} from "./span-bits.js";
import { PushToggle } from "./push-toggle.js";
import { SettingsPanel } from "../settings/settings-panel.js";

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
  const connectionEpoch = useActivityStore((s) => s.connectionEpoch);
  const liveSpans = useActivityStore((s) => s.spans);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const openSettings = useUIStore((s) => s.openSettings);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const setSettingsPanelOpen = useUIStore((s) => s.setSettingsPanelOpen);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const [runs, setRuns] = useState<{ live: ActivityRunSummary[]; history: ActivityRunSummary[] } | null>(null);
  const [rollups, setRollups] = useState<ActivityRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [pricingStale, setPricingStale] = useState(false);

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
    // Surface the pricing warning only when the table is stale AND refreshes
    // are failing — a merely-aging table heals itself. A rejection (including
    // 404 from a server that predates the route) means no signal: stay quiet.
    api
      .pricingState()
      .then((s) => setPricingStale(Boolean(s.stale && s.error)))
      .catch(() => setPricingStale(false));
    void loadInbox();
  };

  // Re-runs on every reconnect (connectionEpoch): the new socket has no
  // server-side subscriptions, and the REST refresh heals whatever finished
  // while disconnected.
  useEffect(() => {
    refresh();
    if (supported) {
      sendClientMessage({ type: "activity_subscribe", view: "index" });
      return () => {
        sendClientMessage({ type: "activity_unsubscribe", view: "index" });
      };
    }
    return undefined;
  }, [supported, connectionEpoch]);

  // Deep-link consumer: `#/activity/<runId>` (the push notification landing
  // spot — the shell routes it here but leaves the hash intact) opens that
  // run's detail. Opening/closing detail writes the hash back via
  // history.replaceState so the link stays shareable without history spam.
  useEffect(() => {
    const applyHash = () => {
      const match = /^#\/activity\/(.+)$/.exec(window.location.hash);
      if (match) setDetailRunId(decodeURIComponent(match[1]!));
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  function showDetail(runId: string | null) {
    setDetailRunId(runId);
    const target = runId ? `#/activity/${encodeURIComponent(runId)}` : "#/activity";
    if (window.location.hash !== target) {
      // window-qualified: `history` is the run list in this scope.
      window.history.replaceState(null, "", target);
    }
  }

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
    showDetail(row.runId);
  }

  /** An inbox tap routes like any run row: chat for session runs, detail otherwise. */
  function openIntent(intent: ActivityIntent) {
    const liveRoot = liveRoots.find((r) => r.runId === intent.runId);
    if (liveRoot) {
      openRun({ runId: liveRoot.runId, origin: liveRoot.origin, sessionId: liveRoot.sessionId });
      return;
    }
    const known = [...(runs?.live ?? []), ...(runs?.history ?? [])].find(
      (r) => r.runId === intent.runId
    );
    if (known) {
      openRun(known);
    } else {
      showDetail(intent.runId);
    }
  }

  if (detailRunId) {
    return <RunDetail runId={detailRunId} onBack={() => showDetail(null)} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Hosted here like GraphPage does: the chat page (the usual host) is
          hidden while this view is active, so the staleness deep-link below
          needs its own panel mount. */}
      <SettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <ActivityIcon className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Activity</h1>
        <div className="ml-auto flex items-center gap-2">
          {pricingStale && (
            <button
              type="button"
              onClick={() => openSettings("models")}
              className="flex items-center gap-1 rounded-md p-1.5 text-amber-500 transition-colors hover:bg-surface-raised hover:text-amber-400"
              aria-label="Pricing refresh is failing — costs may use stale rates. Open Settings"
              title="Pricing refresh is failing — costs may use stale rates. Open Settings"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="hidden text-[10px] sm:inline">Pricing stale</span>
            </button>
          )}
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
                      openIntent(intent);
                    }}
                  >
                    {intent.title}
                  </button>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {formatRelativeTime(intent.createdAt)}
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

/** Today's key in the server's configured zone (mirrors its day formatter). */
function todayKey(timeZone: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", dateStyle: "short" });
  }
  return fmt.format(new Date());
}

function RollupCards({ rollups }: { rollups: ActivityRollups }) {
  // days[0] is merely the newest day WITH runs — on a quiet day that is
  // yesterday, so look today up by its actual key (0 when absent).
  const today = rollups.days.find((d) => d.day === todayKey(rollups.timeZone));
  const week = rollups.days.reduce(
    (acc, d) => ({
      runs: acc.runs + d.runs,
      failures: acc.failures + d.failures,
      costUsd: acc.costUsd + d.costUsd,
      effectiveCostUsd: acc.effectiveCostUsd + (d.effectiveCostUsd ?? 0),
      unpricedRuns: acc.unpricedRuns + (d.unpricedRuns ?? 0),
      tokens: acc.tokens + d.inputTokens + d.outputTokens,
    }),
    { runs: 0, failures: 0, costUsd: 0, effectiveCostUsd: 0, unpricedRuns: 0, tokens: 0 }
  );
  // A server that predates pricing omits the effective fields entirely; the
  // card then keeps its single list-price number instead of claiming an
  // effective $0.00 it never computed.
  const hasEffective = rollups.days.some((d) => d.effectiveCostUsd !== undefined);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatCard label="Runs today" value={String(today?.runs ?? 0)} />
      <StatCard
        label="Failures (7d)"
        value={String(week.failures)}
        alert={week.failures > 0}
      />
      <StatCard
        label="Spend (7d)"
        value={
          hasEffective
            ? formatAggregateCost(week.effectiveCostUsd, week.unpricedRuns)
            : `$${week.costUsd.toFixed(2)}`
        }
        secondary={
          hasEffective && (
            <>
              list ${week.costUsd.toFixed(2)}
              {week.unpricedRuns > 0 && (
                <>
                  {/* Two cards per row below `sm`: the qualifier compacts. */}
                  <span className="hidden sm:inline"> · {week.unpricedRuns} unpriced</span>
                  <span className="sm:hidden"> · {week.unpricedRuns}?</span>
                </>
              )}
            </>
          )
        }
      />
      <StatCard label="Tokens (7d)" value={formatTokenCount(week.tokens)} />
    </div>
  );
}

function StatCard({
  label,
  value,
  secondary,
  alert,
}: {
  label: string;
  value: string;
  /** Muted small line between the value and the label (e.g. the list-cost qualifier). */
  secondary?: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-3">
      <div className={cn("text-lg font-semibold", alert && "text-destructive")}>{value}</div>
      {secondary && (
        <div className="truncate text-[10px] text-muted-foreground/70">{secondary}</div>
      )}
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
  const children = useActivityStore(
    useShallow((s) => Object.values(s.spans[span.runId] ?? {}).filter((x) => x.parentSpanId))
  );
  const now = useNow();
  const current = children.filter((c) => c.outcome === undefined).at(-1);
  const currentLabel = current ? spanToolLabel(current) : null;
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
        {formatDuration(now - span.startedAt)}
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
  const failed = isFailureOutcome(run.outcome);
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
        {/* Effective cost only — list price lives on the Spend card and the
            detail view. "—" is unknown, never $0.00 (AE3). */}
        <span>{formatEffectiveCost(run.effectiveCostUsd, run.pricingEstimate)}</span>
        {run.durationMs !== null && (
          <span className="flex items-center gap-0.5">
            <Timer className="h-3 w-3" />
            {formatDuration(run.durationMs)}
          </span>
        )}
        <span>{formatRelativeTime(run.startedAt)}</span>
      </span>
    </button>
  );
}

/** Chat-less run detail (cron runs; pruned runs show their rollup). */
function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const streamed = useActivityStore(useShallow((s) => runSpans(s, runId)));
  const applySnapshot = useActivityStore((s) => s.applySnapshot);
  const [pruned, setPruned] = useState<object | null>(null);
  const [rollup, setRollup] = useState<ActivityRunRollup | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api
      .activityRun(runId)
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
        {rollup && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              list{" "}
              <span className="font-[family-name:var(--font-mono)] text-foreground/80">
                {formatEffectiveCost(rollup.costUsd)}
              </span>
            </span>
            <span>
              effective{" "}
              <span className="font-[family-name:var(--font-mono)] text-foreground/80">
                {formatEffectiveCost(rollup.effectiveCostUsd, rollup.pricingEstimate)}
              </span>
            </span>
            {rollup.billingMode && (
              <span>{rollup.billingMode === "api" ? "API billed" : "subscription billed"}</span>
            )}
            {rollup.pricingEstimate && <span>~ estimated rates</span>}
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
      </div>
    </div>
  );
}

/** One span tree row; tool spans expand to their recorded payload (AE7). */
function DetailSpanRow({ span, depth }: { span: ActivitySpan; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = span.kind === "tool";
  return (
    <div style={{ paddingLeft: `${depth * 16}px` }}>
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          expandable && "cursor-pointer hover:text-foreground"
        )}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      >
        <SpanStatusDot span={span} />
        <span className="truncate font-[family-name:var(--font-mono)]">
          {spanToolLabel(span)}
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
        {expandable && (
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")}
          />
        )}
      </div>
      {expanded && <SpanPayload spanId={span.spanId} />}
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
