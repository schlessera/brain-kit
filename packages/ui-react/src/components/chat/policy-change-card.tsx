import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApprovalCard, Button, Callout, DiffBlock, Disclosure, Overlay } from "@schlessera/brain-ui-kit";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { useBrainApi, useBrainUiRoot } from "../../root-context.js";
import { useChatStore, type ToolCall } from "../../stores/chat-store.js";
import { rememberFileEntry } from "../../lib/file-entry-focus.js";

/** A policy approval retains the host's receipt in the same transcript slot. */
export function PolicyChangeCard({ toolCall, onApproval }: {
  toolCall: ToolCall; onApproval?: (id: string, approved: boolean, always?: boolean) => boolean | void;
}) {
  const root = useBrainUiRoot(), api = useBrainApi();
  const sessionId = useChatStore(s => s.activeSessionId);
  const initial = toolCall.policyChange!;
  const [review, setReview] = useState(initial), [verified, setVerified] = useState(false), [busy, setBusy] = useState(false);
  const [reader, setReader] = useState(false), [readError, setReadError] = useState("");
  const receipt = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLElement | null>(null);
  const explicit = useRef(false), generation = useRef(0), sent = useRef(false);
  const owner = useRef({ sessionId, epoch: root.authLock.epoch() });
  const current = useCallback(() => owner.current.sessionId === root.stores.chat.getState().activeSessionId && owner.current.epoch === root.authLock.epoch(), [root]);
  const terminal = (value: PolicyChangeReview) => !["pending", "writing", "unknown"].includes(value.state);
  const check = useCallback(async () => {
    const token = ++generation.current;
    setReadError("");
    try {
      const next = await api.policyProposal(initial.turnId, initial.requestId, owner.current.sessionId);
      if (!current() || token !== generation.current) return;
      if (next.turnId !== initial.turnId || next.requestId !== initial.requestId) throw new Error("Different request receipt");
      setVerified(true);
      if (sent.current && next.state === "pending") {
        setReview({ ...next, state: "unknown", message: "The host has not confirmed this answer. Check again reads the same request; it never repeats the write." });
      } else setReview(next);
      if (next.state === "writing") setBusy(true);
      else if (terminal(next) || next.state === "unknown") setBusy(false);
    } catch {
      if (!current() || token !== generation.current) return;
      setReadError("Could not read this request's receipt. Check again reads the same request; it never repeats the write.");
      if (sent.current) { setReview(value => ({ ...value, state: "unknown" })); setBusy(false); }
    }
  }, [api, current, initial.requestId, initial.turnId]);
  useEffect(() => { void check(); const invalidate = () => { generation.current++; }; return invalidate; }, [check]);
  useEffect(() => {
    if (toolCall.policyChange && current()) {
      setReview(toolCall.policyChange);
      if (toolCall.policyChange.state === "writing") setBusy(true);
      else if (terminal(toolCall.policyChange) || toolCall.policyChange.state === "unknown") setBusy(false);
    }
  }, [current, toolCall.policyChange]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => { if (current()) { setReview(value => ({ ...value, state: "unknown", message: "Didn't hear back. Check again reads this request; it never repeats the write." })); setBusy(false); } }, 10_000);
    return () => clearTimeout(timer);
  }, [busy, current]);
  useLayoutEffect(() => {
    if (explicit.current && (busy || review.state !== "pending")) { explicit.current = false; receipt.current?.focus({ preventScroll: true }); }
  }, [busy, review.state]);
  function decide(approved: boolean) {
    if (!verified || !current() || busy || sent.current || review.state !== "pending" || !onApproval) return;
    sent.current = true;
    if (onApproval(toolCall.id, approved) === false) { sent.current = false; return; }
    explicit.current = true; setBusy(true); setReader(false);
    setReview(value => ({ ...value, state: "writing", message: approved ? "Writing the policy…" : "Recording the decline…" }));
  }
  const openFile = (opener: HTMLElement, keyboard: boolean) => {
    if (!current()) return;
    rememberFileEntry(root, opener, keyboard); root.stores.ui.getState().openPanel("files");
    void root.stores.file.getState().openFile(review.path);
  };
  const diffs = <>
    <p className="text-xs">Changed sections: {review.sections.length ? review.sections.join(", ") : "frontmatter values unchanged"}.</p>
    <div className="max-h-80 min-w-0 overflow-auto">{review.frontmatterDiff ? <DiffBlock tinted variant="inset" text={review.frontmatterDiff} /> : <p className="text-xs">Frontmatter bytes unchanged.</p>}</div>
    <p className="text-xs">{review.bodyChanged ? "Body text changed." : "Body text unchanged."}</p>
    {review.bodyChanged && <div className="[&_[role=button]]:min-h-11"><Disclosure label="Read body diff"><div className="max-h-80 min-w-0 overflow-auto"><DiffBlock tinted variant="inset" text={review.bodyDiff} /></div></Disclosure></div>}
  </>;
  const pending = review.state === "pending" && !busy;
  return <div data-policy-change data-policy-state={review.state} className="min-w-0 space-y-2 text-foreground" style={{ overflowWrap: "anywhere" }}>
    {pending ? <div data-approval-card role="group" aria-label="Policy change proposed">
      <ApprovalCard tool="Policy change proposed" target={review.path} badge="Review policy" wrapHeader wrapActions diff="" risk=""
        allowLabel="Approve and write" denyLabel="Decline" onAllow={verified && !readError ? () => decide(true) : undefined} onDeny={verified && !readError ? () => decide(false) : undefined}>
        <p className="text-xs text-muted-foreground">Agent rationale</p><blockquote className="text-sm">“{review.rationale}”</blockquote>
        <p className="font-mono text-xs">Exact base: {review.baseHash ?? "no policy file"}</p>
        {!verified ? <p className="text-xs" role="status">Reading the complete proposal…</p> : diffs}
        {review.warnings.map(warning => <Callout key={warning} tone="gold" text={warning} />)}
        {readError && <Callout tone="gold" text={readError} />}
        <Button label="Read full policy diff" tone="quiet" size="md" style={{ minHeight: 44, marginBlock: 8 }} onClick={() => { trigger.current = document.activeElement as HTMLElement; setReader(true); }} />
        {readError && <Button label="Check again" tone="quiet" size="md" style={{ minHeight: 44 }} onClick={() => void check()} />}
      </ApprovalCard>
      <span className="sr-only" role="status">Policy change proposed. Review before approving.</span>
    </div> : <div ref={receipt} tabIndex={-1} data-policy-receipt className="rounded-md border border-border-subtle p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
      <p role="status" className="text-sm">{busy ? review.message : readError || review.message}</p>
      <p className="font-mono text-xs">{review.state === "updated" ? `${review.baseHash ?? "defaults"} → ${review.proposedHash}` : `Based on ${review.baseHash ?? "no policy file"}`}</p>
      {review.state === "updated" && <Button label="View policy" tone="quiet" size="md" style={{ minHeight: 44 }} onClick={() => { const opener = document.activeElement; if (opener instanceof HTMLElement) openFile(opener, opener.matches(":focus-visible")); }} />}
      {!busy && (review.state === "unknown" || readError) && <Button label="Check again" tone="quiet" size="md" style={{ minHeight: 44 }} onClick={() => { explicit.current = true; void check(); }} />}
    </div>}
    <Overlay open={reader} onClose={() => setReader(false)} variant="dialog" title="Policy diff" size="lg" initialFocus={heading}
      returnFocus={() => trigger.current?.isConnected ? trigger.current : receipt.current}>
      <h2 ref={heading} tabIndex={-1} className="text-lg">Review the exact policy changes</h2>
      <p className="font-mono text-xs">Base: {review.baseHash ?? "no policy file"}</p>{diffs}
    </Overlay>
  </div>;
}
