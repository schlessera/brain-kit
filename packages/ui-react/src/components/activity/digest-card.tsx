import { useEffect, useState } from "react";

import type { ActionDigestSummary, ActivityDigest } from "../../lib/api-client.js";
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
 *
 * The same fetch carries this client's Actions/FYI contribution, refreshed at
 * its local 09:00 and 17:00. It lists only decisions and updates new since the
 * last summary; an unchanged waiting decision stays in Actions instead.
 */
export function DigestCard() {
  const api = useBrainApi();
  const [digest, setDigest] = useState<ActivityDigest | null>(null);
  const [actions, setActions] = useState<ActionDigestSummary | null>(null);
  const [visible, setVisible] = useState(false);
  const setActiveView = useUIStore((s) => s.setActiveView);

  useEffect(() => {
    let active = true;
    setDigest(null);
    setActions(null);
    setVisible(false);
    void api
      .activityDigest()
      .then(({ digest, dismissedAt, actions }) => {
        if (!active) return;
        const freshDigest = digest && digest.runs > 0 && digest.generatedAt > dismissedAt ? digest : null;
        const latest = actions?.status === "ready" ? actions.latest : null;
        const freshActions =
          latest && latest.waiting.length + latest.updates.length > 0 && latest.generatedAt > dismissedAt ? latest : null;
        if (!freshDigest && !freshActions) return;
        setDigest(freshDigest);
        setActions(freshActions);
        setVisible(true);
      })
      .catch(() => {
        // No digest is a quiet state, never an error surface.
      });
    return () => { active = false; };
  }, [api]);

  if (!visible || (!digest && !actions)) return null;

  function dismiss() {
    setVisible(false);
    void api.activityDigestDismiss().catch(() => {});
  }

  return (
    <DigestSummary
      digest={digest}
      actions={actions}
      windowLabel={
        digest
          ? `${formatDay(digest.windowStart)} – ${formatDay(digest.windowEnd)}`
          : `Actions, ${formatSlot(actions!.slotAt)}`
      }
      // Effective-only spend clause; a digest persisted before pricing shipped
      // falls back to its old list-cost clause inside the helper.
      costClause={digest ? digestCostClause(digest) : null}
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

function formatSlot(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
