import { useRef, useState } from "react";
import { ApprovalCard, Callout, DiffBlock, Disclosure } from "@schlessera/brain-ui-kit";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { useBrainUiRoot } from "../../root-context.js";

/** A sync's `policy_review` frame (#4256): the host-owned review of an incoming policy change. */
export interface SyncPolicyReviewFrame { turn_id: string; request_id: string; review: PolicyChangeReview }

export function isSyncPolicyReviewFrame(value: unknown): value is SyncPolicyReviewFrame & { type: "policy_review" } {
  const frame = value as Partial<SyncPolicyReviewFrame> & { type?: unknown };
  return !!frame && frame.type === "policy_review" && typeof frame.turn_id === "string" && typeof frame.request_id === "string"
    && !!frame.review && typeof frame.review === "object" && typeof frame.review.state === "string";
}

/**
 * The owner's review of a policy change a sync's pull brought in, with the
 * same exact-diff presentation as a chat policy card. Nothing was published;
 * only Approve writes, through the host's policy writer, and the owner syncs
 * again afterwards. The answer is sent once and never repeated.
 */
export function SyncPolicyReview({ frame }: { frame: SyncPolicyReviewFrame }) {
  const root = useBrainUiRoot();
  const [review, setReview] = useState(frame.review);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sent = useRef(false), receipt = useRef<HTMLDivElement>(null);
  async function decide(approve: boolean) {
    if (sent.current || busy || review.state !== "pending") return;
    sent.current = true; setBusy(true); setError("");
    try {
      const response = await root.request(root.backendUrl(`/api/brain/sync/policy/${encodeURIComponent(frame.turn_id)}/${encodeURIComponent(frame.request_id)}`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }),
      });
      const body = await response.json().catch(() => null) as (PolicyChangeReview & { error?: string }) | null;
      if (!response.ok || !body || typeof body.state !== "string") throw new Error(body?.error ?? `HTTP ${response.status}`);
      setReview(body);
    } catch (cause) {
      setError(`The host did not confirm this answer (${cause instanceof Error ? cause.message : "unknown error"}). Sync again to see the review's state.`);
    } finally { setBusy(false); queueMicrotask(() => receipt.current?.focus({ preventScroll: true })); }
  }
  const pending = review.state === "pending" && !busy && !sent.current;
  return <div data-sync-policy-review data-policy-state={review.state} className="mt-3 min-w-0 space-y-2 text-foreground" style={{ overflowWrap: "anywhere" }}>
    {pending ? <div data-approval-card role="group" aria-label="Incoming policy change">
      <ApprovalCard tool="Incoming policy change" target={review.path} badge="Review policy" wrapHeader wrapActions diff="" risk=""
        allowLabel="Approve and write" denyLabel="Decline" onAllow={() => void decide(true)} onDeny={() => void decide(false)}>
        <p className="text-xs text-muted-foreground">From the sync</p><blockquote className="text-sm">{review.rationale}</blockquote>
        <p className="font-mono text-xs">Exact base: {review.baseHash ?? "no policy file"}</p>
        <p className="text-xs">Changed sections: {review.sections.length ? review.sections.join(", ") : "frontmatter values unchanged"}.</p>
        <div className="max-h-80 min-w-0 overflow-auto">{review.frontmatterDiff ? <DiffBlock tinted variant="inset" text={review.frontmatterDiff} /> : <p className="text-xs">Frontmatter bytes unchanged.</p>}</div>
        <p className="text-xs">{review.bodyChanged ? "Body text changed." : "Body text unchanged."}</p>
        {review.bodyChanged && <div className="[&_[role=button]]:min-h-11"><Disclosure label="Read body diff"><div className="max-h-80 min-w-0 overflow-auto"><DiffBlock tinted variant="inset" text={review.bodyDiff} /></div></Disclosure></div>}
        {review.warnings.map(warning => <Callout key={warning} tone="gold" text={warning} />)}
      </ApprovalCard>
      <span className="sr-only" role="status">Incoming policy change. Review before approving.</span>
    </div> : <div ref={receipt} tabIndex={-1} data-policy-receipt className="rounded-md border border-border-subtle p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
      <p role="status" className="text-sm">{busy ? "Sending your answer…" : error || review.message}</p>
      {review.state === "updated" && !error && <p className="text-xs">The policy is adopted. Sync again to finish the sync.</p>}
    </div>}
  </div>;
}
