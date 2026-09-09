import type { ReactNode } from "react";

import type { ActivityRollups } from "../../lib/api-client.js";
import { cn } from "../../lib/utils.js";
import { formatTokenCount } from "../chat/tool-views.js";
import { formatAggregateCost } from "./span-bits.js";

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

export function RollupCards({ rollups }: { rollups: ActivityRollups }) {
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
