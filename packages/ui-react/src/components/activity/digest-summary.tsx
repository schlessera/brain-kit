import { Button, DigestCard } from "@schlessera/brain-ui-kit";
import type { DigestGroup } from "@schlessera/brain-ui-kit";
import type { ActionDigestSummary, ActivityDigest } from "../../lib/api-client.js";

/**
 * The while-you-were-away card as the design draws it: the kit `DigestCard`
 * — "the briefing as one chat block, ordered settled → needs-you so it can
 * be abandoned halfway" — with the app's two actions under it. Rendered from
 * props (S7); `DigestCard` in `digest-card.tsx` is the container.
 *
 * The kit card does no arithmetic, so the counts arrive as strings; the
 * notable runs (failures, at most three) and the decisions waiting since the
 * last summary are the groups that need you. Either half may be absent: an
 * activity window with no runs, or no new Actions for this client.
 */
export interface DigestSummaryProps {
  digest: ActivityDigest | null;
  /** This client's newest Actions/FYI contribution, when it has new entries. */
  actions?: ActionDigestSummary | null;
  windowLabel: string;
  costClause: string | null;
  onDismiss: () => void;
  onOpen: () => void;
}

export function DigestSummary(p: DigestSummaryProps) {
  const d = p.digest;
  const groups: DigestGroup[] = [];
  const subtitle: string[] = [p.windowLabel];
  if (d) {
    const runs = `${d.runs} run${d.runs === 1 ? "" : "s"}`;
    subtitle.push(runs);
    if (d.failures > 0) subtitle.push(`${d.failures} failed`);
    groups.push({ label: "Ran", icon: "agent", tone: "teal", count: String(d.runs), items: [{ text: p.windowLabel, meta: p.costClause ?? undefined }] });
    if (d.failures > 0) {
      groups.push({
        label: "Failed",
        icon: "failed",
        tone: "red",
        count: String(d.failures),
        items: d.notable.slice(0, 3).map((n) => ({ text: n.jobName ?? n.name, meta: n.outcome ?? undefined })),
      });
    }
  }
  const a = p.actions;
  if (a && a.updates.length > 0) {
    groups.push({
      label: "Updates",
      icon: "resolved",
      tone: "teal",
      count: String(a.updates.length),
      items: a.updates.slice(0, 3).map((u) => ({ text: u.title })),
    });
  }
  if (a && a.waiting.length > 0) {
    // Last, nearest the button: the decisions are what needs you.
    subtitle.push(`${a.waiting.length} waiting`);
    groups.push({
      label: "Waiting on you",
      icon: "approval",
      tone: "amber",
      count: String(a.waiting.length),
      items: a.waiting.slice(0, 3).map((w) => ({ text: w.title })),
    });
  }
  return (
    <div className="mx-auto mb-3 w-full max-w-2xl">
      <DigestCard
        title="While you were away"
        subtitle={subtitle.join(" · ")}
        spend={d ? p.costClause ?? "" : ""}
        groups={groups}
        footnote=""
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={p.onDismiss} />
        <Button label="Open Actions" icon="resolved" tone="primary" size="sm" block={false} onClick={p.onOpen} />
      </div>
    </div>
  );
}
