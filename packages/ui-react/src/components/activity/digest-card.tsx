import { useEffect, useMemo, useRef, useState } from "react";

import type { ActionDigestSummary, ActivityDigest } from "../../lib/api-client.js";
import { useBrainApi } from "../../root-context.js";
import { noticeClientId, onNotificationZoneReported } from "../../lib/push-registration.js";
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

  const clientId = useMemo(() => noticeClientId(), []);
  /** Bumped by every read and by dismissal, so an older response never lands. */
  const request = useRef(0);
  /** Newest summary dismissed here, ahead of the server's marker catching up. */
  const dismissedThrough = useRef(0);

  useEffect(() => {
    let active = true;
    // A different API root is a different server: forget this one's dismissal.
    dismissedThrough.current = 0;
    setDigest(null);
    setActions(null);
    setVisible(false);
    const load = () => {
      const current = ++request.current;
      void api
        .activityDigest(clientId)
        .then(({ digest, dismissedAt, actions }) => {
          if (!active || current !== request.current) return;
          const seen = (at: number, marker: number) => at > marker && at > dismissedThrough.current;
          const freshDigest = digest && digest.runs > 0 && seen(digest.generatedAt, dismissedAt) ? digest : null;
          // Actions summaries carry this client context's own dismissal.
          const latest = actions?.status === "ready" ? actions.latest : null;
          const actionsDismissedAt = actions?.status === "ready" ? actions.dismissedAt ?? 0 : 0;
          const freshActions =
            latest && latest.waiting.length + latest.updates.length > 0 && seen(latest.generatedAt, actionsDismissedAt) ? latest : null;
          // A refresh with nothing fresh hides a card shown by an earlier read.
          setDigest(freshDigest);
          setActions(freshActions);
          setVisible(Boolean(freshDigest || freshActions));
        })
        .catch(() => {
          // No digest is a quiet state, never an error surface.
        });
    };
    // The server stores this client's summary at its local 09:00 and 17:00;
    // read again just after each, so an open screen picks the new one up.
    let slotTimer: ReturnType<typeof setTimeout> | undefined;
    const armSlot = () => {
      clearTimeout(slotTimer);
      slotTimer = setTimeout(() => { load(); armSlot(); }, msUntilNextSlot(Date.now()) + SLOT_SLACK_MS);
    };
    load();
    armSlot();
    // A first or changed zone report can make a summary due: fetch again,
    // and re-arm the slot timer in case the local zone moved.
    const unsubscribe = onNotificationZoneReported(api, () => { load(); armSlot(); });
    return () => { active = false; clearTimeout(slotTimer); unsubscribe(); };
  }, [api, clientId]);

  if (!visible || (!digest && !actions)) return null;

  function dismiss() {
    request.current++;
    dismissedThrough.current = Math.max(dismissedThrough.current, digest?.generatedAt ?? 0, actions?.generatedAt ?? 0);
    setVisible(false);
    // Zero when no Actions were shown: dismissing activity alone never hides
    // an Actions summary stored after this card's last read.
    void api.activityDigestDismiss(clientId, actions?.generatedAt ?? 0).catch(() => {});
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

/** Read a little after the slot so the server tick has generated it. */
const SLOT_SLACK_MS = 30_000;

/** Milliseconds until this runtime's next local 09:00 or 17:00. */
export function msUntilNextSlot(now: number): number {
  const at = new Date(now);
  for (const day of [0, 1]) {
    for (const hour of [9, 17]) {
      const slot = new Date(at.getFullYear(), at.getMonth(), at.getDate() + day, hour).getTime();
      if (slot > now) return slot - now;
    }
  }
  return 12 * 60 * 60 * 1000;
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSlot(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
