import { useEffect, useState } from "react";

import type { ActivityDigest } from "../../lib/api-client.js";
import { useBrainApi } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { DigestSummary } from "./digest-summary.js";
import { digestCostClause } from "./span-bits.js";

/**
 * The while-you-were-away card: presented PROACTIVELY on app open when a
 * fresh digest exists (planning decision — built passively, the flow
 * collapses back into asking the agent what happened). Once per digest:
 * dismissing persists server-side, so a phone and a laptop don't each nag.
 * An empty window stays quiet — no card for "nothing happened". The window
 * is labeled: the card says what period it covers, never implies "now".
 *
 * This is the container (S7): the fetch, the once-per-digest rule and the
 * dismissal live here; `DigestSummary` draws the kit `DigestCard`.
 */
export function DigestCard() {
  const api = useBrainApi();
  const [digest, setDigest] = useState<ActivityDigest | null>(null);
  const [visible, setVisible] = useState(false);
  const setActiveView = useUIStore((s) => s.setActiveView);

  useEffect(() => {
    let active = true;
    setDigest(null);
    setVisible(false);
    void api
      .activityDigest()
      .then(({ digest, dismissedAt }) => {
        if (!active || !digest || digest.runs === 0) return;
        if (digest.generatedAt <= dismissedAt) return;
        setDigest(digest);
        setVisible(true);
      })
      .catch(() => {
        // No digest is a quiet state, never an error surface.
      });
    return () => { active = false; };
  }, [api]);

  if (!visible || !digest) return null;

  function dismiss() {
    setVisible(false);
    void api.activityDigestDismiss().catch(() => {});
  }

  return (
    <DigestSummary
      digest={digest}
      windowLabel={`${formatDay(digest.windowStart)} – ${formatDay(digest.windowEnd)}`}
      // Effective-only spend clause; a digest persisted before pricing shipped
      // falls back to its old list-cost clause inside the helper.
      costClause={digestCostClause(digest)}
      onDismiss={dismiss}
      onOpen={() => {
        dismiss();
        setActiveView("activity");
      }}
    />
  );
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
