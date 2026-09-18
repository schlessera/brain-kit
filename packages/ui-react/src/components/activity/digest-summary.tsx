import { Button, DigestCard } from "@schlessera/brain-ui-kit";
import type { DigestGroup } from "@schlessera/brain-ui-kit";
import type { ActivityDigest } from "../../lib/api-client.js";

/**
 * The while-you-were-away card as the design draws it: the kit `DigestCard`
 * — "the briefing as one chat block, ordered settled → needs-you so it can
 * be abandoned halfway" — with the app's two actions under it. Rendered from
 * props (S7); `DigestCard` in `digest-card.tsx` is the container.
 *
 * The kit card does no arithmetic, so the counts arrive as strings; the
 * notable runs (failures, at most three) are the one group that needs you.
 */
export interface DigestSummaryProps {
  digest: ActivityDigest;
  windowLabel: string;
  costClause: string | null;
  onDismiss: () => void;
  onOpen: () => void;
}

export function DigestSummary(p: DigestSummaryProps) {
  const d = p.digest;
  const runs = `${d.runs} run${d.runs === 1 ? "" : "s"}`;
  const groups: DigestGroup[] = [
    { label: "Ran", icon: "agent", tone: "teal", count: String(d.runs), items: [{ text: p.windowLabel, meta: p.costClause ?? undefined }] },
  ];
  if (d.failures > 0) {
    groups.push({
      label: "Failed",
      icon: "failed",
      tone: "red",
      count: String(d.failures),
      items: d.notable.slice(0, 3).map((n) => ({ text: n.jobName ?? n.name, meta: n.outcome ?? undefined })),
    });
  }
  return (
    <div className="mx-auto mb-3 w-full max-w-2xl">
      <DigestCard
        title="While you were away"
        subtitle={`${p.windowLabel} · ${runs}${d.failures > 0 ? ` · ${d.failures} failed` : ""}`}
        spend={p.costClause ?? ""}
        groups={groups}
        footnote=""
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={p.onDismiss} />
        <Button label="Open Activity" icon="activity" tone="primary" size="sm" block={false} onClick={p.onOpen} />
      </div>
    </div>
  );
}
