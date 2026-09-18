import { useShallow } from "zustand/react/shallow";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import type { ActivityRunSummary } from "../../lib/api-client.js";
import { useNow } from "../../hooks/use-now.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { formatDuration, formatRelativeTime } from "../chat/tool-views.js";
import { HistoryRow, LiveRunCard, toolState } from "./activity-views.js";
import { runCostText, spanToolLabel } from "./span-bits.js";

/**
 * The containers (S7) for the Activity index's rows: `LiveRow` subscribes to
 * a running run's child spans and renders a `LiveRunCard`; `RunRow` is a
 * recorded run rendered as a `HistoryRow`. The views are in
 * `activity-views.tsx`.
 */
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
  return (
    <LiveRunCard
      name={span.jobName ?? span.name}
      // A span-only run (plain cron job) has no current step — name+elapsed
      // is its whole live story.
      current={current ? spanToolLabel(current) : null}
      elapsed={formatDuration(now - span.startedAt)}
      tools={children.map((c) => ({ label: spanToolLabel(c), state: toolState(c.outcome) }))}
      onOpen={() => onOpen({ runId: span.runId, origin: span.origin, sessionId: span.sessionId })}
    />
  );
}

export function RunRow({
  run,
  onOpen,
}: {
  run: ActivityRunSummary;
  onOpen: (row: ActivityRunSummary) => void;
}) {
  // Effective cost only — list price lives on the Spend card and the detail
  // view. "—" is unknown, never $0.00 (AE3); a pre-pricing server that never
  // sent the field keeps the original list-cost span instead (see runCostText).
  const cost = runCostText(run);
  const meta = [cost, run.durationMs !== null ? formatDuration(run.durationMs) : null, formatRelativeTime(run.startedAt)]
    .filter((s): s is string => Boolean(s))
    .join(" · ");
  return (
    <HistoryRow
      name={run.jobName ?? run.name}
      cron={run.origin === "cron"}
      outcome={run.outcome}
      meta={meta}
      onOpen={() => onOpen(run)}
    />
  );
}
