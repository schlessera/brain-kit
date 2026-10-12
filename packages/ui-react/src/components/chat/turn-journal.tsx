import { ScopeCapCard, scopeReceiptText, scopeNumber } from "./scope-cap-card.js";
import { Button, DiffBlock, Disclosure, Overlay } from "@schlessera/brain-ui-kit";
import type { TurnJournalChange, TurnJournalDetails, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import { useEffect, useRef, useState } from "react";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useTurnRevert } from "./use-turn-revert.js";
import { computeDiffRows, diffText } from "../../lib/diff.js";

/** One initially collapsed receipt for a host turn, including known no-change turns. */
export function TurnJournal({ turnId, summary, live = false }: { turnId?: string; summary?: TurnJournalSummary; live?: boolean }) {
  const root = useBrainUiRoot();
  const sessionId = useChatStore(state => state.activeSessionId);
  const cardScope = useRef({ turnId, sessionId });
  if (cardScope.current.turnId !== turnId) cardScope.current = { turnId, sessionId };
  const cardSession = cardScope.current.sessionId;
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<TurnJournalDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TurnJournalChange | null>(null);
  const [preview, setPreview] = useState<{ inline: boolean; before?: string; after?: string; reason?: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef<string | undefined>(undefined);
  const wrapper = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLElement | null>(null);
  const state = summary?.state ?? "unrecorded";
  const readable = !!sessionId && !!turnId && state !== "unknown" && state !== "unrecorded" && state !== "expired";
  const revert = useTurnRevert(sessionId, turnId, readable && state !== "recording" && summary?.actor !== "voice", open, () => trigger.current?.isConnected ? trigger.current : wrapper.current?.querySelector<HTMLElement>("summary,button") ?? null);
  useEffect(() => {
    setDetails(null); setError(null);
    if (!open || !readable) return;
    const controller = new AbortController();
    root.api.turnJournal(sessionId!, turnId!, controller.signal).then(value => {
      if (!controller.signal.aborted) setDetails(value);
    }).catch(() => { if (!controller.signal.aborted) setError("Couldn't load retained changes. Close and reopen to try again."); });
    return () => controller.abort();
  }, [root, sessionId, turnId, open, readable, summary?.observedAt, summary?.changedFiles, state]);
  useEffect(() => {
    setSelected(null); setPreview(null); setPreviewError(null); setOpen(false);
  }, [sessionId, turnId]);
  useEffect(() => {
    setPreview(null); setPreviewError(null);
    if (!selected || !sessionId || !turnId || !readable) return;
    const controller = new AbortController();
    root.api.turnJournalPreview(sessionId, turnId, selected.sequence, controller.signal).then(value => {
      if (!controller.signal.aborted) setPreview(value);
    }).catch(() => { if (!controller.signal.aborted) setPreviewError("This retained version is unavailable. Close the reader and reopen to try again."); });
    return () => controller.abort();
  }, [root, sessionId, turnId, selected, readable]);
  useEffect(() => { if (!readable) setSelected(null); }, [readable]);
  const count = summary?.changedFiles;
  const changes = count == null ? "Changes unknown" : `${count} changed ${count === 1 ? "file" : "files"}`;
  const steering = summary?.steeringFiles == null ? "Steering unknown" : `${summary.steeringFiles} steering`;
  const cost = summary?.costUsd == null ? "Cost unknown" : `${summary.costIsEstimate ? "Estimated " : ""}$${summary.costUsd.toFixed(4)}`;
  const budget = summary?.budget;
  const budgetLabel = budget?.scopes.some(item=>item.blocked) ? "Budget reached" : budget?.scopes.some(item=>item.warning) ? "Budget warning" : budget ? "Inference limits" : summary?.scope ? "Scope limits recorded" : "Limits unknown";
  const label = `${changes} · ${steering} · ${cost} · ${budgetLabel}${state === "recording" ? " · Recording" : state === "partial" ? " · Incomplete" : state === "expired" ? " · Details expired" : state === "unrecorded" || state === "unknown" ? " · Unrecorded" : ""}`;
  useEffect(() => {
    if (!live || !turnId || announced.current === turnId || !["complete", "partial"].includes(state)) return;
    announced.current = turnId; setAnnouncement(`Turn journal: ${changes} · ${cost}. ${state === "partial" ? "Incomplete." : ""}`);
  }, [live, turnId, state, changes, cost]);
  const groups = details ? [
    ["Steering", details.changes.filter(change => change.class === "steering")],
    ["Policy", details.changes.filter(change => change.class === "policy")],
    ["Content", details.changes.filter(change => change.class === "content" && !change.scope && !change.before?.ignored && !change.after?.ignored && (change.before?.kind ?? change.after?.kind) !== "other")],
    ["Workspaces", details.changes.filter(change => change.class === "content" && !!change.scope && !change.before?.ignored && !change.after?.ignored && (change.before?.kind ?? change.after?.kind) !== "other")],
    ["Non-revertible changes", details.changes.filter(change => change.class === "content" && (change.before?.ignored || change.after?.ignored || (change.before?.kind ?? change.after?.kind) === "other"))],
  ] as const : [];
  return <div ref={wrapper} className="mt-3 min-w-0" data-turn-journal={turnId ?? "unrecorded"}>
    {live && <span className="sr-only" role="status" aria-live="polite">{announcement}</span>}
    {turnId && cardSession && summary?.scope?.receipts.map(receipt => receipt.state === "paused" && summary.actor === "voice" ? null : <ScopeCapCard key={receipt.eventId} receipt={receipt} turnId={turnId} sessionId={cardSession} blockedBy={receipt.state === "paused" && receipt.eventId !== summary.scope?.receipts.at(-1)?.eventId ? summary.scope?.receipts.at(-1) : undefined} />)}
    <Disclosure label={label} open={open} onOpenChange={setOpen}>
      <div className="grid gap-3 text-sm min-w-0">
        <p>{state === "expired" ? "Retained details expired. Raw versions and review actions are unavailable." : state === "unknown" || state === "unrecorded" ? "No retained journal is available for this turn. Change counts and costs are unknown." : "Only versions observed while this turn was running are retained. Writes overwritten between observations cannot be recovered."}</p>
        {summary?.sharedAttribution && <p>Overlapping turns shared this writable window. These observations do not identify an exclusive writer.</p>}
        {summary?.profile && <p>{summary.actor === "user" ? "Original worker profile" : "Profile"}: {summary.profile}. {summary.actor === "voice" ? "Voice turn." : summary.actor === "user" ? "User history operation." : "Interactive turn."}</p>}
        <p>Model: {summary?.model ?? "unknown"}.</p>
        {budget ? <div className="grid gap-2" data-inference-budget>
          <p>Completed-response list-price usage: {budget.listPriceCostUsd === null ? "unknown" : `${budget.listPriceIsEstimate ? "estimated " : ""}$${budget.listPriceCostUsd.toFixed(4)}`}. This is not a subscription invoice or the effective cost above.</p>
          <p>{budget.coverage}.</p>
          {budget.scopes.map(item=><p key={item.scope}>{item.scope === "day" ? "UTC day" : item.scope === "session" ? "Conversation lifetime" : "Turn"}: {item.costUsd === null ? "price unknown" : `$${item.costUsd.toFixed(4)} observed lower bound`}; {item.tokens === null ? "tokens unknown" : `${item.tokens.toLocaleString()} tokens`}. Warn ${item.warnUsd}; stop ${item.blockUsd}.{item.warnTokens !== undefined ? ` Unpriced token warning: ${item.warnTokens.toLocaleString()}.` : ""} Unpriced token stop: {item.blockTokens.toLocaleString()}.{item.legacyRuns ? " Includes legacy Activity totals; their recorded transcript attribution may be cumulative." : ""}{item.warning ? " Warning threshold reached." : ""}{item.blocked ? " Stop threshold reached." : ""}{item.resetAt ? ` Resets ${new Date(item.resetAt).toISOString()}.` : ""}</p>)}
          <p>Measured {new Date(budget.observedAt).toISOString()}. Retained measurements are historical, not the current balance.</p>
        </div> : <p>Inference limits: unknown.</p>}
        {summary?.scope ? <section className="grid gap-2"><h3>Scope limits</h3><p>{summary.scope.calls} tool calls · {Number(summary.scope.minutes.toFixed(3))} min · {summary.scope.changedPaths ?? "Unknown"} distinct changed paths · {summary.scope.observedBytes ?? "Unknown"} observed bytes.</p>
          <p>Ceilings: {summary.scope.limits.tool_calls} calls · {summary.scope.limits.minutes} min · {summary.scope.limits.files_changed} paths · {summary.scope.limits.turn_bytes} bytes. Independent hard timeout: {summary.scope.hardTimeoutMs / 60_000} min. Host resource and storage limits also remain binding.</p>
          <ul className="grid gap-2">{summary.scope.receipts.map(receipt => <li key={receipt.eventId} className="break-words">{scopeReceiptText(receipt)}. Cap: {scopeNumber(receipt.dimension, receipt.cap)}; observed overshoot: {scopeNumber(receipt.dimension, receipt.overshoot)}.</li>)}</ul>
          <p>Coverage: {summary.scope.coverage === "partial" ? "Incomplete observation; missing counts are unknown." : "Observed versions in brain, scratch and workspaces; writes overwritten between observations are not captured."} Distinct paths and bytes may include overlapping writers. Free-space floor: max(5%, 2 GiB), Stop only.</p></section> : <p>Scope limits: unknown.</p>}
        {state === "partial" && <p>Observation stopped before every detail could be retained. Partial work remains; this journal cannot fully reverse the turn.</p>}
        {readable && !details && !error && <p>Loading retained changes…</p>}
        {error && <p role="status">{error}</p>}
        {details?.missing.map((missing, index) => <p key={`${missing.path}-${index}`} className="break-words">Unavailable: {missing.path} ({missing.reason})</p>)}
        {revert.controls}
        {groups.map(([name, entries]) => entries.length > 0 && <section key={name} className="min-w-0"><h3 className="font-medium">{name}</h3><ul className="grid gap-2 mt-2">{entries.map(change => <li key={`${change.sequence}-${change.path}`} className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <span className="break-all min-w-0">{change.path}{change.tainted === true && change.taintSourceEventId && <span className="block text-muted-foreground">Review recommended: recorded untrusted input (source event {change.taintSourceEventId}).</span>} <span className="text-muted-foreground">{change.before?.bytes ?? 0} → {change.after?.bytes ?? 0} bytes{change.actor === "user" ? " · Approved by you" : ""}</span></span>
          {(change.before?.hash || change.after?.hash || change.before?.kind === "symlink" || change.after?.kind === "symlink") && <span data-journal-review={change.sequence}><Button label="Review" ariaLabel={`Review ${change.path}`} size="sm" block={false} style={{ minHeight: 44 }} onClick={() => { trigger.current = wrapper.current?.querySelector<HTMLElement>(`[data-journal-review="${change.sequence}"] [role="button"]`) ?? null; setSelected(change); }} /></span>}
        </li>)}</ul></section>)}
        {!!details?.outwardActions?.length && <section className="min-w-0"><h3 className="font-medium">Outward actions</h3>
          <p className="mt-2">These receipts record approval, not external completion. External actions are irreversible here; restoring local files cannot undo them.</p>
          <ul className="grid gap-2 mt-2">{details.outwardActions.map(action => <li key={action.id} className="break-all min-w-0">
            {({ git_push: "Git push", gh_write: "GitHub write", mcp_tool: "Outward tool", http_write: "HTTP write", outward_host_connect: "Outward connection" })[action.action]} · {({ policy_allowed: "Allowed by policy", approved: "Approved", declined: "Declined", refused: "Refused" })[action.decision]} · {action.target ?? "Destination unresolved"}{action.historyRewrite ? " · Remote history rewrite" : ""}
          </li>)}</ul>
          {details.outwardActionsTruncated && <p className="mt-2">Showing the first 1,000 outward receipts. More remain in the retained governance records.</p>}
        </section>}
      </div>
    </Disclosure>
    <Overlay open={!!selected && readable} variant="dialog" size="xl" label="Retained change" initialFocus={heading} returnFocus={() => trigger.current?.isConnected ? trigger.current : wrapper.current?.querySelector<HTMLElement>("summary,button") ?? null} onClose={() => setSelected(null)}>
      <div className="grid gap-4 min-w-0 p-4">
        <h2 ref={heading} tabIndex={-1} className="font-medium break-all">{selected?.path}</h2>
        <p className="text-sm text-muted-foreground">Observed raw version · {selected?.before?.bytes ?? 0} → {selected?.after?.bytes ?? 0} bytes</p>
        {selected?.tainted === true && selected.taintSourceEventId && <p className="text-sm">Review recommended: this steering observation follows recorded untrusted input (source event {selected.taintSourceEventId}).</p>}
        {!preview && !previewError && <p>Loading retained version…</p>}
        {previewError && <p role="status">{previewError}</p>}
        {preview?.inline ? <div className="max-h-[60vh] overflow-auto min-w-0"><DiffBlock tinted variant="inset" text={diffText(computeDiffRows(preview.before ?? "", preview.after ?? ""))} /></div> : preview && <p>Inline diff unavailable ({preview.reason}). Raw versions remain available below.</p>}
        {!previewError && selected && sessionId && turnId && <div className="flex flex-wrap gap-3 text-sm">{(["before", "after"] as const).map(side => selected[side]?.hash && <a key={side} className="inline-flex min-h-11 items-center underline" href={`${root.apiBase()}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/journal/${selected.sequence}/${side}`} download>Download {side} ({selected[side]?.bytes} bytes)</a>)}</div>}
        {selected && revert.action(selected.path)}
        <Button label="Close" style={{ minHeight: 44 }} onClick={() => setSelected(null)} />
      </div>
    </Overlay>
    {revert.announcement}
    {revert.dialog}
  </div>;
}
