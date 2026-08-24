import { useEffect, useState } from "react";
import { AlertTriangle, Newspaper, X } from "lucide-react";

import { api, type ActivityDigest } from "../../lib/api-client.js";
import { useUIStore } from "../../stores/ui-store.js";
import { cn } from "../../lib/utils.js";

/**
 * The while-you-were-away card: presented PROACTIVELY on app open when a
 * fresh digest exists (planning decision — built passively, the flow
 * collapses back into asking the agent what happened). Once per digest:
 * dismissing persists server-side, so a phone and a laptop don't each nag.
 * An empty window stays quiet — no card for "nothing happened". The window
 * is labeled: the card says what period it covers, never implies "now".
 */
export function DigestCard() {
  const [digest, setDigest] = useState<ActivityDigest | null>(null);
  const [visible, setVisible] = useState(false);
  const setActiveView = useUIStore((s) => s.setActiveView);

  useEffect(() => {
    void api
      .activityDigest()
      .then(({ digest, dismissedAt }) => {
        if (!digest || digest.runs === 0) return;
        if (digest.generatedAt <= dismissedAt) return;
        setDigest(digest);
        setVisible(true);
      })
      .catch(() => {
        // No digest is a quiet state, never an error surface.
      });
  }, []);

  if (!visible || !digest) return null;

  function dismiss() {
    setVisible(false);
    void api.activityDigestDismiss().catch(() => {});
  }

  const windowLabel = `${formatDay(digest.windowStart)} – ${formatDay(digest.windowEnd)}`;

  return (
    <div
      className={cn(
        "mx-auto mb-3 w-full max-w-2xl rounded-xl border p-3 text-xs",
        digest.failures > 0
          ? "border-destructive/30 bg-destructive/5"
          : "border-border-subtle bg-surface"
      )}
    >
      <div className="flex items-center gap-2">
        <Newspaper className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">While you were away</span>
        <span className="text-[10px] text-muted-foreground/60">{windowLabel}</span>
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 text-muted-foreground">
        {digest.runs} run{digest.runs === 1 ? "" : "s"}
        {digest.failures > 0 && (
          <span className="text-destructive"> · {digest.failures} failed</span>
        )}
        {digest.costUsd > 0 && ` · $${digest.costUsd.toFixed(2)} spent`}
      </div>
      {digest.notable.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {digest.notable.slice(0, 3).map((n) => (
            <div key={n.runId} className="flex items-center gap-1.5 text-[11px]">
              <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
              <span className="truncate">
                {n.jobName ?? n.name} — {n.outcome}
              </span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          dismiss();
          setActiveView("activity");
        }}
        className="mt-2 text-[11px] font-medium text-primary hover:underline"
      >
        Open Activity
      </button>
    </div>
  );
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
