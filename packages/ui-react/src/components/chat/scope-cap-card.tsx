/** Server scope decisions reuse the in-turn ask-user card; no text/model grant path. */
import { AskUserCard, Button } from "@schlessera/brain-ui-kit";
import type { ScopeCapReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { useEffect, useRef, useState } from "react";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";

export const scopeLimitName: Record<ScopeCapReceipt["dimension"], string> = {
  files_changed: "File limit", minutes: "Time limit", tool_calls: "Tool-call limit", turn_bytes: "Write allowance", free_space_floor: "Free-space floor",
};
export function scopeNumber(dimension: ScopeCapReceipt["dimension"], value: number): string {
  return dimension === "turn_bytes" || dimension === "free_space_floor" ? `${value.toLocaleString("en-US")} bytes`
    : dimension === "minutes" ? `${value} min` : `${value.toLocaleString("en-US")} ${dimension === "tool_calls" ? "tool calls" : "distinct paths"}`;
}
export function scopeReceiptText(receipt: ScopeCapReceipt): string {
  const state = receipt.state === "continued" ? `continued · limit ${scopeNumber(receipt.dimension, receipt.newCap!)} for this turn`
    : receipt.state === "ended_before_answer" ? "the turn ended before an answer" : receipt.state === "paused" ? "turn paused" : "turn stopped";
  return `${scopeLimitName[receipt.dimension]} reached at ${scopeNumber(receipt.dimension, receipt.count)} · ${state}`;
}
export function ScopeCapCard({ receipt, turnId, sessionId, blockedBy }: { receipt: ScopeCapReceipt; turnId: string; sessionId: string; blockedBy?: ScopeCapReceipt }) {
  const root = useBrainUiRoot();
  const activeSession = useChatStore(state => state.activeSessionId);
  const delivery = useChatStore(state => state.scopeDecisionReceipts[receipt.eventId]);
  const connected = useConnectionStore(state => state.wsStatus === "connected");
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const activated = useRef(false), submission = useRef<string | undefined>(undefined), action = useRef<"continue" | "stop">("stop");
  const row = useRef<HTMLParagraphElement>(null), announced = useRef<string | undefined>(undefined);
  const paused = receipt.state === "paused" && !blockedBy;
  useEffect(() => {
    if (announced.current === receipt.eventId) return;
    announced.current = receipt.eventId;
    setAnnouncement(paused ? `Turn paused: ${scopeReceiptText(receipt)}. ${receipt.newCap === undefined ? "Stop only." : "Continue or stop."}` : scopeReceiptText(receipt));
  }, [receipt, paused]);
  useEffect(() => {
    if (paused || !activated.current) return;
    setPending(false);
    if (root.stores.chat.getState().activeSessionId === sessionId) row.current?.focus();
    setAnnouncement(scopeReceiptText(receipt)); activated.current = false;
  }, [receipt, paused, root, sessionId]);
  useEffect(() => {
    if (!delivery || delivery.submissionId !== submission.current || delivery.turnId !== turnId || delivery.sessionId !== sessionId) return;
    setPending(false);
    if (["refused", "failed"].includes(delivery.state)) setError(delivery.reason ?? "The host could not confirm the action. Check status before trying again.");
    else if (delivery.state === "pending") setError("The turn is still paused. Your previous action was not accepted; try it again manually.");
    else if (delivery.state === "answered_elsewhere") setAnnouncement("This scope limit was answered from another device.");
  }, [delivery, turnId, sessionId]);
  function send(next: "continue" | "stop" | "readback") {
    if (!connected || root.stores.chat.getState().activeSessionId !== sessionId) return;
    if (next !== "readback" && !submission.current) submission.current = crypto.randomUUID();
    if (!submission.current) submission.current = crypto.randomUUID();
    if (next !== "readback") { activated.current = true; action.current = next; }
    setError(null); setPending(true);
    if (!root.connection.send({ type: "scope_decision", sessionId, turnId, eventId: receipt.eventId, submissionId: submission.current, action: next })) {
      setPending(false); setError("The action was not sent. Reconnect, then check status manually.");
    }
  }
  const reason = activeSession !== sessionId ? "Open this chat to answer its limit." : !connected ? "Needs the host to answer · the turn stays paused." : pending ? "Waiting for the host's receipt. If it is lost, check status manually." : error;
  return <div className="brain-scope-card min-w-0 break-words" data-scope-event={receipt.eventId}>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    {paused ? <>
      <AskUserCard id={receipt.eventId} tone="amber" prompt={pending ? "Continuing or stopping…" : "▲ Turn paused"}
        question={`${receipt.dimension === "free_space_floor" ? "This turn reached the brain's free-space floor." : `This turn reached its ${scopeLimitName[receipt.dimension].toLowerCase()}.`} Observed: ${scopeNumber(receipt.dimension, receipt.count)}. Limit: ${scopeNumber(receipt.dimension, receipt.cap)}. ${receipt.frozen ? "Nothing in the worker is running while it waits." : "A frozen worker was not confirmed."}${receipt.overshoot > 0 ? ` Observed overshoot: ${scopeNumber(receipt.dimension, receipt.overshoot)}.` : ""} Partial work and observed journal versions remain.`}
        showActions={false} options={[
          ...(receipt.newCap === undefined ? [] : [{ title: "Continue", subtitle: `Raises this limit to exactly ${scopeNumber(receipt.dimension, receipt.newCap)} for this turn only. Your policy is unchanged.`, disabled: !!reason, onClick: () => send("continue") }]),
          { title: "Stop here", subtitle: receipt.newCap === undefined ? "This limit allows Stop only. Partial work remains." : "Ends this turn. Partial work remains.", disabled: !!reason, onClick: () => send("stop") },
        ]} />
      {reason && <p className="mt-2 text-sm">{reason}</p>}
      {(pending || error) && <Button label="Check status" disabled={!connected || activeSession !== sessionId} style={{ minHeight: 44 }} onClick={() => send("readback")} />}
      {error && !pending && connected && <Button label={`Try ${action.current === "continue" ? "Continue" : "Stop"} again`} style={{ minHeight: 44 }} onClick={() => send(action.current)} />}
    </> : <p ref={row} tabIndex={-1} data-scope-receipt={receipt.eventId} className="text-sm break-words">{scopeReceiptText(receipt)}{blockedBy ? ". The free-space floor now requires Stop only." : ""}{receipt.reason ? `. ${receipt.reason}` : ""}</p>}
  </div>;
}
