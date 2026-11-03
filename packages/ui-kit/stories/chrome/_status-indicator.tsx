import { useState } from "react";

import { StatusIndicator, type StatusIndicatorOperation, type StatusIndicatorState } from "../../src/chrome/StatusIndicator.js";
import { Button } from "../../src/primitives/Button.js";
import { IconButton } from "../../src/primitives/IconButton.js";

/**
 * Presentational scenes for #3281, with Odysseus fixtures only. The states,
 * facts and actions are what a consumer would supply; none of this is product
 * wiring. #3155 (draft saving) and #3231 (deletion recovery) own the runtime.
 */

export type DraftCase = "empty" | "saving" | "uploading" | "saved" | "offline" | "unknown" | "file-failed" | "refused";

const DRAFT: Record<Exclude<DraftCase, "empty">, { state: StatusIndicatorState; stateLabel: string; summary: string; explanation: string; facts?: { key: string; value: string }[] }> = {
  saving: { state: "active", stateLabel: "Saving the draft", summary: "Saving the draft to the brain now.", explanation: "The host has not acknowledged this revision yet. Leaving now keeps the at-risk guard." },
  uploading: { state: "queued", stateLabel: "Waiting for the raft sketch to upload", summary: "The draft saves once raft-sketch.jpg finishes uploading.", explanation: "Waiting on a known prerequisite. Nothing is saved yet.", facts: [{ key: "Waiting on", value: "raft-sketch.jpg (1 of 1)" }] },
  saved: { state: "success", stateLabel: "Draft saved", summary: "Saved: the host acknowledged this exact text and its file.", explanation: "Editing the text or files clears this until the new revision is acknowledged.", facts: [{ key: "Acknowledged", value: "12 Jul 2026, 07:42" }, { key: "Files", value: "raft-sketch.jpg" }] },
  offline: { state: "attention", stateLabel: "Offline: draft not saved", summary: "Offline. The draft is kept on this device and saves when you reconnect.", explanation: "Nothing has reached the host since 07:40." },
  unknown: { state: "unknown", stateLabel: "Couldn't confirm the draft was saved", summary: "The save reply was lost. The draft may or may not be stored.", explanation: "No acknowledgement arrived for this revision. Treat it as unsaved.", facts: [{ key: "Last confirmed", value: "12 Jul 2026, 07:31" }] },
  "file-failed": { state: "failed", stateLabel: "raft-sketch.jpg wasn't stored", summary: "The text is pending; one file failed to store.", explanation: "Remove the file or attach it again.", facts: [{ key: "File", value: "raft-sketch.jpg" }] },
  refused: { state: "refused", stateLabel: "Draft refused: storage is full", summary: "The host refused the draft: the brain's draft space is full.", explanation: "Free space in Storage, then edit the draft to save again." },
};

/** #3155's placement: Attach, then the indicator, then the model label. */
export function DraftToolRow({ draft, onAttach = () => {}, onSend = () => {} }: { draft: DraftCase; onAttach?: () => void; onSend?: () => void }) {
  const d = draft === "empty" ? undefined : DRAFT[draft];
  const operations: StatusIndicatorOperation[] = d ? [{ id: "draft-odysseus-raft", state: d.state, stateLabel: d.stateLabel, explanation: d.explanation, facts: d.facts }] : [];
  return <div data-draft-row="" style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", gap: 0, width: "100%", minWidth: 0, padding: "4px 8px", boxSizing: "border-box", border: "1px solid var(--bk-color-edge)", borderRadius: 16, background: "var(--bk-color-raised)" }}>
    <IconButton name="Attach files" icon="attach" onClick={onAttach} data-draft-attach="" />
    <StatusIndicator label="Draft" title="Draft status" summary={d?.summary ?? ""} operations={operations} />
    <span data-model-label="" style={{ flex: "1 1 auto", minWidth: 0, padding: "0 8px", overflowWrap: "anywhere", color: "var(--bk-color-ink-mute)", font: "400 .8125rem/1.4 'JetBrains Mono', ui-monospace, monospace" }}>Claude Sonnet · Odysseus</span>
    <IconButton name="Send" icon="send" onClick={onSend} data-draft-send="" />
  </div>;
}

export type DeletionAction = { operation: string; action: "check" | "retry" };

/** #3231's placement: one Sessions-header summary beside close, independent of chat rows. */
export function SessionsHeader({ operations = deletionOperations(), onAction = () => {}, onClose = () => {} }: { operations?: StatusIndicatorOperation[]; onAction?: (a: DeletionAction) => void; onClose?: () => void }) {
  const withActions = operations.map(o => ({ ...o, actions: o.state === "success" ? undefined : <>
    <Button size="sm" block={false} reach label="Check now" onClick={() => onAction({ operation: o.id, action: "check" })} />
    {o.state === "failed" || o.state === "unknown" ? <Button size="sm" tone="ghost" block={false} reach label="Retry removal" onClick={() => onAction({ operation: o.id, action: "retry" })} /> : null}
  </> }));
  const unresolved = operations.filter(o => o.state !== "success").length;
  return <header data-sessions-header="" style={{ display: "flex", alignItems: "center", gap: 0, width: "100%", padding: "4px 8px", boxSizing: "border-box", borderBottom: "1px solid var(--bk-color-edge)" }}>
    <h2 style={{ flex: "1 1 auto", minWidth: 0, margin: 0, font: "400 1.25rem/1.3 'DM Serif Text', serif", color: "var(--bk-color-ink)" }}>Sessions</h2>
    <StatusIndicator label="Chat deletions" title="Chat deletions" returnFocus={() => document.querySelector<HTMLElement>("[data-sessions-close]")}
      summary={unresolved === 0 ? "Every requested removal is confirmed." : `${unresolved} chat removal${unresolved === 1 ? " isn't" : "s aren't"} confirmed yet. Titles are not kept.`}
      operations={withActions} />
    <IconButton name="Close sessions" icon="dismiss" onClick={onClose} data-sessions-close="" />
  </header>;
}

export function deletionOperations(): StatusIndicatorOperation[] {
  return [
    { id: "deletion-7f3a", state: "unknown", stateLabel: "Couldn't confirm removal", explanation: "The host stopped replying before it confirmed every store. The chat title is not kept.",
      facts: [{ key: "Requested", value: "12 Jul 2026, 09:14" }, { key: "Device", value: "Odysseus's phone" }, { key: "Stores left", value: "transcript, attachments" }, { key: "Last check", value: "09:15" }] },
    { id: "deletion-91c2", state: "failed", stateLabel: "Attachment cleanup failed", explanation: "The transcript is gone; attachment storage refused the removal.",
      facts: [{ key: "Requested", value: "12 Jul 2026, 08:50" }, { key: "Device", value: "Ogygia desktop" }, { key: "Stores left", value: "attachments" }, { key: "Last check", value: "09:02" }] },
  ];
}

const SYNC_STEPS: { state: StatusIndicatorState; stateLabel: string; summary: string }[] = [
  { state: "queued", stateLabel: "Waiting for the connection", summary: "The crew ledger syncs when Ithaca's relay is reachable." },
  { state: "active", stateLabel: "Syncing the crew ledger", summary: "Sending the crew ledger to the brain." },
  { state: "success", stateLabel: "Crew ledger synced", summary: "The host confirmed the crew ledger." },
];

/** A generic queued → active → success / unknown example with no product wiring. */
export function SyncExample() {
  const [step, setStep] = useState(0);
  const [lost, setLost] = useState(false);
  const [progress, setProgress] = useState(0);
  const current = lost ? { state: "unknown" as const, stateLabel: "Couldn't confirm the sync", summary: "The reply was lost. The ledger may not be stored." } : SYNC_STEPS[step]!;
  const facts = current.state === "active" ? [{ key: "Sent", value: `${progress} of 40 entries` }] : undefined;
  return <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
    <StatusIndicator label="Crew ledger" title="Crew ledger sync" summary={current.summary} operations={[{ id: "sync-crew-ledger", state: current.state, stateLabel: current.stateLabel, facts }]} />
    <Button size="sm" tone="ghost" block={false} label="Next step" onClick={() => { setLost(false); setStep(s => Math.min(s + 1, SYNC_STEPS.length - 1)); }} />
    <Button size="sm" tone="ghost" block={false} label="Report progress" onClick={() => setProgress(n => n + 1)} />
    <Button size="sm" tone="ghost" block={false} label="Lose the reply" onClick={() => setLost(true)} />
  </div>;
}

export const MATRIX: { state: StatusIndicatorState; stateLabel: string }[] = [
  { state: "active", stateLabel: "Saving the raft list" },
  { state: "queued", stateLabel: "Waiting for the upload" },
  { state: "success", stateLabel: "Saved" },
  { state: "attention", stateLabel: "Offline" },
  { state: "unknown", stateLabel: "Couldn't confirm saved" },
  { state: "failed", stateLabel: "File wasn't stored" },
  { state: "refused", stateLabel: "Refused: space is full" },
  { state: "idle", stateLabel: "Nothing pending" },
];
