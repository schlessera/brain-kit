import { AlertTriangle, Bot, Clock, Timer } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isFailureOutcome, type ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import type { ActivityRunSummary } from "../../lib/api-client.js";
import { useNow } from "../../hooks/use-now.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { cn } from "../../lib/utils.js";
import { formatDuration, formatRelativeTime } from "../chat/tool-views.js";
import { runCostText, spanToolLabel } from "./span-bits.js";

export function LiveRow({
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

export function RunRow({
  run,
  onOpen,
}: {
  run: ActivityRunSummary;
  onOpen: (row: ActivityRunSummary) => void;
}) {
  const failed = isFailureOutcome(run.outcome);
  // Effective cost only — list price lives on the Spend card and the detail
  // view. "—" is unknown, never $0.00 (AE3); a pre-pricing server that never
  // sent the field keeps the original list-cost span instead (see runCostText).
  const cost = runCostText(run);
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
        {cost !== null && <span>{cost}</span>}
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
