import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Overlay, Label, Button, IconButton, TextButton } from "@schlessera/brain-ui-kit";
import {
  composeHandoffText,
  HANDOFF_DRAFT_MESSAGES,
  HANDOFF_MAX_CHARS,
  HANDOFF_MAX_REFERENCES,
  type ClientMessage,
  type ProviderInfo,
  type UnavailableProfileInfo,
} from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useHandoffStore } from "../../stores/handoff-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { useOpenSession } from "../../hooks/use-open-session.js";
import { countTurns, deterministicDraft, snapshotSource, suggestedReferences, type HandoffSnapshot } from "../../lib/handoff.js";
import { detectClientEnvironment } from "../../lib/client-environment.js";
import { cn } from "../../lib/utils.js";

/** How long the sheet waits for an unloaded source's history. */
const HISTORY_WAIT_MS = 5000;
/** How long a just-replayed history must stay unchanged before it is snapshotted. */
const HISTORY_SETTLE_MS = 250;
/** How long a send may go unacknowledged before it reads as uncertain. */
const ACK_WAIT_MS = 15000;

type ReferenceState = "checking" | "readable" | "missing" | "unreadable";
interface Reference {
  path: string;
  state: ReferenceState;
}
type Origin = "deterministic" | "model" | "user" | "none";

/**
 * The client's copy for a closed unavailability reason (#1044). The host
 * sends only the enum; a reason this client does not know yet reads as a
 * generic one rather than leaking through.
 */
export function unavailableReasonCopy(reason: string): string {
  return reason === "needs-credentials" ? "needs credentials" : "can't run now";
}

/** Where a choice of destination profile stands. */
function destinationWhy(
  profile: ProviderInfo | undefined,
  connected: boolean,
  unavailable: UnavailableProfileInfo | undefined
): string | undefined {
  if (!connected) return "host offline";
  if (!profile && unavailable) return unavailableReasonCopy(unavailable.reason);
  if (!profile) return "choose another backend";
  return undefined;
}

/**
 * Continue a conversation on another backend (#61; design approved
 * 2026-10-05). Opening the sheet snapshots the source at its latest settled
 * turn and runs one `handoff preparation` summary on the SOURCE's own
 * backend; the deterministic draft from the last six messages is the
 * fallback when that run is stopped, fails, or cannot run. The user reviews
 * and edits; nothing reaches the destination before `Start new chat`, and
 * starting it grants no tool permission.
 */
export function HandoffSheet() {
  const root = useBrainUiRoot();
  const sheet = useHandoffStore((s) => s.sheet);
  // Stable across renders: the review's cleanup (which stops a running
  // summary) must run when the review leaves, not on every parent render.
  const send = useCallback((message: ClientMessage) => root.connection.send(message), [root]);
  if (!sheet) return null;
  // Keyed by the review: a new open is a new review with its own key.
  return <HandoffReview key={sheet.handoffId} sourceSessionId={sheet.sourceSessionId} handoffId={sheet.handoffId} awaitHistory={sheet.awaitHistory === true} send={send} />;
}

function HandoffReview({ sourceSessionId, handoffId, awaitHistory, send }: {
  sourceSessionId: string;
  handoffId: string;
  /** The source was just opened: snapshot its fresh history, not a cached buffer. */
  awaitHistory: boolean;
  send: (message: ClientMessage) => boolean | void;
}) {
  const root = useBrainUiRoot();
  const titleId = useId();
  const pointer = useMediaQuery("(min-width: 900px)");
  const openSession = useOpenSession();
  const toRef = useRef<HTMLSelectElement>(null);


  const handoff = useHandoffStore((s) => s);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const providers = useProviderStore((s) => s.available);
  const backends = useProviderStore((s) => s.backends);
  const pinnedId = useProviderStore((s) => s.pinnedId);
  const sourceBackendId = useChatStore((s) => s.backendIds[sourceSessionId]);
  const source = useChatStore((s) => s.buffers[sourceSessionId]);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const runState = useChatStore((s) => s.runStates[sourceSessionId]);

  const sourceProfile = providers.find((p) => p.id === pinnedId && activeSessionId === sourceSessionId)
    ?? providers.find((p) => p.backendId === sourceBackendId);
  const sourceName = sourceProfile?.label ?? sourceBackendId ?? "this chat's model";
  const destinations = useMemo(
    () => providers.filter((p) => p.backendId && p.backendId !== sourceBackendId),
    [providers, sourceBackendId]
  );
  const canSummarize = Boolean(sourceBackendId && backends[sourceBackendId]?.capabilities.autonomous);

  // Configured on another backend but unable to run now (#1044): listed,
  // disabled, with the reason printed; never chosen.
  const unavailableProfiles = useProviderStore((s) => s.unavailable);
  const unavailableDestinations = useMemo(
    () => unavailableProfiles.filter((p) => p.backendId && p.backendId !== sourceBackendId),
    [unavailableProfiles, sourceBackendId]
  );

  const [destinationId, setDestinationId] = useState<string>(
    () => destinations[0]?.id ?? unavailableDestinations[0]?.id ?? ""
  );
  const destination = destinations.find((p) => p.id === destinationId);
  const unavailableDestination = destination ? undefined : unavailableDestinations.find((p) => p.id === destinationId);
  function chooseDestination(id: string) {
    if (destinations.some((p) => p.id === id)) setDestinationId(id);
  }
  const [snapshot, setSnapshot] = useState<HandoffSnapshot | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [text, setText] = useState("");
  const [origin, setOrigin] = useState<Origin>("none");
  const [references, setReferences] = useState<Reference[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<null | { text: string; origin: Origin }>(null);

  // --- Snapshot, at open (§3): the latest settled turn, once history is here.
  // A source opened just now replays its history in one or more chunks; the
  // snapshot waits until the transcript has stopped growing for a moment.
  const historyLoaded = useChatStore((s) => s.historyLoads[sourceSessionId] ?? 0);
  const [loadsAtOpen] = useState(historyLoaded);
  const ready = !awaitHistory || historyLoaded > loadsAtOpen;
  useEffect(() => {
    if (snapshot || historyError) return;
    if (ready && source && source.messages.length > 0) {
      if (!awaitHistory) { setSnapshot(snapshotSource(source, runState)); return; }
      const timer = setTimeout(() => setSnapshot(snapshotSource(source, runState)), HISTORY_SETTLE_MS);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setHistoryError(true), HISTORY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [source, snapshot, historyError, ready, awaitHistory, runState]);

  function checkReference(path: string) {
    const clean = path.trim().replace(/^\.?\/+/, "");
    if (!clean) return;
    setReferences((current) =>
      current.some((r) => r.path === clean) || current.length >= HANDOFF_MAX_REFERENCES
        ? current
        : [...current, { path: clean, state: clean.split("/").some((part) => part.startsWith(".")) ? "unreadable" : "checking" }]
    );
    if (clean.split("/").some((part) => part.startsWith("."))) return;
    root.api.fileResolve(clean).then(
      (result) => setReferences((current) => current.map((r) => r.path === clean
        ? { ...r, state: result.exists ? (result.type === "file" ? "readable" : "unreadable") : "missing" }
        : r)),
      () => setReferences((current) => current.map((r) => r.path === clean ? { ...r, state: "unreadable" } : r))
    );
  }

  const runs = useRef(0);
  const running = useRef<string | null>(null);
  function prepare(turns: number) {
    if (!canSummarize) return;
    const prepareId = `${handoffId}-p${++runs.current}`;
    running.current = prepareId;
    root.stores.handoff.getState().startPrepare(prepareId);
    if (send({ type: "handoff_prepare", handoffId: prepareId, sourceSessionId, turns }) === false) {
      running.current = null;
      root.stores.handoff.getState().setDraft(prepareId, { state: "failed", message: "Couldn't reach the host." });
    }
  }

  function stopSummary() {
    const prepareId = running.current;
    if (!prepareId) return;
    running.current = null;
    send({ type: "handoff_prepare_cancel", handoffId: prepareId });
    root.stores.handoff.getState().setDraft(prepareId, { state: "cancelled" });
  }

  /** Put text in the field, unless that would overwrite edits without asking. */
  function offerText(next: string, nextOrigin: Origin) {
    if (origin === "user" && next !== text) setConfirmReplace({ text: next, origin: nextOrigin });
    else { setText(next); setOrigin(nextOrigin); }
  }

  // When the snapshot lands (and on each explicit Refresh): the fallback
  // draft, the suggested references, and (R1) a summary run, which starts
  // now whether or not the handoff is then started.
  useEffect(() => {
    if (!snapshot) return;
    offerText(deterministicDraft(snapshot.messages), "deterministic");
    for (const path of suggestedReferences(snapshot.messages)) checkReference(path);
    prepare(countTurns(snapshot.messages));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // The summary replaces only text nobody touched; edits are never overwritten silently.
  const draft = handoff.draft;
  useEffect(() => {
    if (draft.state !== "running") running.current = null;
    if (draft.state !== "ready" || draft.text === undefined) return;
    offerText(draft.text, "model");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.state, draft.text]);

  // The host aborts a closed connection's run and cannot answer it. Fall back
  // to the no-model draft; a new run starts only on an explicit Refresh.
  useEffect(() => {
    if (connected || !running.current) return;
    const prepareId = running.current;
    running.current = null;
    root.stores.handoff.getState().setDraft(prepareId, { state: "failed", message: "The connection dropped, so no summary was drafted." });
  }, [connected, root]);

  // Leaving with the run still going stops it: nobody is left to read it.
  useEffect(() => () => {
    if (running.current) send({ type: "handoff_prepare_cancel", handoffId: running.current });
  }, [send]);

  // --- Created: open the destination; the source is untouched.
  const created = handoff.created;
  useEffect(() => {
    if (!created) return;
    const store = root.stores.handoff.getState();
    const sent = store.pendingSend;
    const backendId = providers.find((p) => p.id === (sent?.providerId ?? destinationId))?.backendId;
    store.addLink(
      sourceSessionId,
      { sessionId: created.sessionId, title: null, ...(backendId ? { backendId } : {}), afterTurns: countTurns(source?.messages ?? snapshot?.messages ?? []) },
      { sessionId: sourceSessionId, title: sourceTitle(), ...(sourceBackendId ? { backendId: sourceBackendId } : {}) }
    );
    if (created.live) {
      // The destination's buffer already holds the reviewed message and
      // streams its first reply; viewing it needs no history load.
      root.stores.chat.getState().setActiveSession(created.sessionId);
      if (sent) root.stores.provider.getState().setPinned(sent.providerId);
    } else {
      openSession(created.sessionId);
    }
    store.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created]);

  // An unacknowledged send turns uncertain when the socket drops or the ack never comes.
  const phase = handoff.phase;
  useEffect(() => {
    if (phase.kind !== "creating" && phase.kind !== "checking") return;
    if (!connected) { root.stores.handoff.getState().setPhase({ kind: "uncertain" }); return; }
    const timer = setTimeout(() => root.stores.handoff.getState().setPhase({ kind: "uncertain" }), ACK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase.kind, connected, root]);

  function sourceTitle(): string | null {
    const first = snapshot?.messages.find((m) => m.role === "user")?.content.trim();
    return first ? first.slice(0, 60) : null;
  }

  // --- New content during review (§3).
  const settledNow = source ? snapshotSource(source, runState).messages.length : 0;
  const newSince = snapshot ? Math.max(0, settledNow - snapshot.messages.length) : 0;
  function refreshDraft() {
    if (!source) return;
    stopSummary();
    setSnapshot(snapshotSource(source, runState));
  }

  function onType(value: string) {
    // Typing stops the summary and keeps what was written (R1).
    stopSummary();
    setText(value);
    setOrigin("user");
  }

  const readable = references.filter((r) => r.state === "readable");
  const excluded = references.filter((r) => r.state === "missing" || r.state === "unreadable");
  const checking = references.some((r) => r.state === "checking");
  const over = text.length > HANDOFF_MAX_CHARS;
  const busy = phase.kind === "creating" || phase.kind === "checking";
  const why = !connected ? "needs the host"
    : destinationWhy(destination, connected, unavailableDestination)
    ?? (over ? "shorten the handoff" : !text.trim() ? "write the handoff" : checking ? "checking references" : undefined);

  function start() {
    if (why || busy || !destination) return;
    const store = root.stores.handoff.getState();
    stopSummary();
    const requestId = crypto.randomUUID();
    const paths = readable.map((r) => r.path);
    store.beginSend({ handoffId, requestId, draftId: handoffId, text: composeHandoffText(text, paths), providerId: destination.id });
    const sent = send({
      type: "chat_message",
      text,
      providerId: destination.id,
      requestId,
      draftId: handoffId,
      client: detectClientEnvironment(),
      source: "handoff",
      handoff: { handoffId, sourceSessionId, references: paths },
    });
    if (sent === false) store.setPhase({ kind: "uncertain" });
  }

  function checkAgain() {
    root.stores.handoff.getState().setPhase({ kind: "checking" });
    if (send({ type: "handoff_status", handoffId }) === false) root.stores.handoff.getState().setPhase({ kind: "uncertain" });
  }

  function cancel() {
    if (busy) return;
    root.stores.handoff.getState().close();
  }

  const draftLabel = historyError && !snapshot
    ? "Couldn't load this chat's history. Write the handoff yourself."
    : draft.state === "running"
      ? `Drafting a summary with ${sourceName} · spends`
      : origin === "model"
        ? `summarized by ${sourceName} · ${draft.costUsd !== undefined ? `$${draft.costUsd.toFixed(2)}` : "cost unknown"}`
        : origin === "user"
          ? "your text"
          : `drafted from the last ${HANDOFF_DRAFT_MESSAGES} messages · no model`;
  const draftNote = draft.state === "failed" && draft.message && origin !== "model" ? `No summary: ${draft.message}` : null;

  function submitReference() {
    if (adding === null) return;
    checkReference(adding);
    setAdding(null);
  }

  const body = (
    <div className="flex flex-col" style={{ maxHeight: pointer ? "min(86vh, 760px)" : "calc(92dvh - 132px)" }}>
      {/* Everything that can grow scrolls; the outcome and the actions stay in view. */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1">
      {/* To */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${titleId}-to`}><Label text="To" /></label>
        {destinations.length === 0 && unavailableDestinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other backend is set up on this host.</p>
        ) : (
          <select
            id={`${titleId}-to`}
            ref={toRef}
            value={destinationId}
            disabled={busy}
            onChange={(e) => chooseDestination(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {destinations.map((p) => (
              <option key={p.id} value={p.id} disabled={!connected}>
                {p.label} · {p.backendId}{p.billingMode === "api" ? " · spends" : ""}{!connected ? " — host offline" : ""}
              </option>
            ))}
            {unavailableDestinations.map((p) => (
              <option key={`unavailable:${p.id}`} value={p.id} disabled>
                {p.label} · {p.backendId} — {!connected ? "host offline" : unavailableReasonCopy(p.reason)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Handoff text */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${titleId}-text`}><Label text="Handoff · edit freely" /></label>
          <span className={cn("font-mono text-[11px]", over ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
            {text.length} / {HANDOFF_MAX_CHARS}
          </span>
        </div>
        <textarea
          id={`${titleId}-text`}
          value={text}
          disabled={busy}
          onChange={(e) => onType(e.target.value)}
          rows={pointer ? 7 : 6}
          aria-busy={draft.state === "running" || undefined}
          aria-describedby={`${titleId}-source`}
          className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        />
        <div id={`${titleId}-source`} className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-muted-foreground" aria-live="polite">
          <span className={cn("font-mono", draft.state === "running" && "animate-pulse")}>{draftLabel}</span>
          {draft.state === "running" ? (
            <TextButton tone="link" label="Stop" style={{ minWidth: 44 }} onClick={stopSummary} />
          ) : null}
        </div>
        {draftNote ? <p className="text-[11px] text-muted-foreground">{draftNote}</p> : null}
        {confirmReplace ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
            <span className="flex-1">Replace your edits?</span>
            <Button tone="ghost" size="sm" block={false} style={{ minHeight: 44 }} label="Keep mine" onClick={() => setConfirmReplace(null)} />
            <Button tone="primary" size="sm" block={false} style={{ minHeight: 44 }} label="Replace" onClick={() => { setText(confirmReplace.text); setOrigin(confirmReplace.origin); setConfirmReplace(null); }} />
          </div>
        ) : null}
        {snapshot?.running ? (
          <p className="text-xs text-muted-foreground">A reply is still running here. It isn't included, and it keeps running.</p>
        ) : null}
        {newSince > 0 ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span>{newSince === 1 ? "1 new message" : `${newSince} new messages`} since you opened this ·</span>
            <TextButton tone="link" label="Refresh draft" onClick={refreshDraft} disabled={busy} />
          </div>
        ) : null}
      </div>

      {/* References */}
      <div className="flex flex-col gap-1.5">
        <Label text="References" />
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="References">
          {references.map((r) => {
            const off = r.state === "missing" || r.state === "unreadable";
            const reason = r.state === "missing" ? "missing" : r.state === "unreadable" ? `not readable by ${destination?.backendId ?? "the destination"}` : r.state === "checking" ? "checking" : undefined;
            return (
              <li key={r.path} className={cn("inline-flex min-h-11 items-center gap-1 rounded-md border border-border pl-2 font-mono text-[11px]", off ? "text-muted-foreground" : "text-foreground")}>
                <span className={off ? "line-through" : undefined}>{r.path}</span>
                {reason ? <span className="font-sans text-[10px] text-muted-foreground">{reason}</span> : null}
                <IconButton size="sm" name={`Remove reference ${r.path}`} icon="dismiss"
                  disabled={busy} onClick={() => setReferences((current) => current.filter((x) => x.path !== r.path))} />
              </li>
            );
          })}
          <li>
            {adding === null ? (
              <TextButton tone="link" label="+ add a file" onClick={() => setAdding("")} disabled={busy || references.length >= HANDOFF_MAX_REFERENCES} />
            ) : (
              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); submitReference(); }}>
                <input
                  autoFocus
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAdding(null); } }}
                  placeholder="plans/ithaca.md"
                  aria-label="Brain file path"
                  className="min-h-11 w-44 rounded-md border border-border bg-background px-2 font-mono text-xs"
                />
                <Button tone="ghost" size="sm" block={false} style={{ minHeight: 44 }} label="Add" onClick={submitReference} />
              </form>
            )}
          </li>
        </ul>
        <p className="text-[11px] text-muted-foreground">Links in the text stay text; nothing opens on its own.</p>
      </div>

      {/* Not carried over, always visible */}
      <div className="flex flex-col gap-1">
        <Label text="Not carried over" />
        <ul className="list-inside list-disc text-xs text-muted-foreground">
          <li>the rest of this chat ({snapshot?.messages.length ?? 0} {(snapshot?.messages.length ?? 0) === 1 ? "message" : "messages"})</li>
          {snapshot && snapshot.pendingApprovals > 0 ? (
            <li className="text-destructive">{snapshot.pendingApprovals === 1 ? "1 pending approval" : `${snapshot.pendingApprovals} pending approvals`} · stays here</li>
          ) : null}
          <li>remembered permissions</li>
          {snapshot?.running ? <li>a running reply · stays here</li> : null}
          {excluded.map((r) => <li key={r.path}>{r.path} · {r.state === "missing" ? "missing" : "not readable"}</li>)}
        </ul>
      </div>

      </div>

      {/* Outcome of Start new chat (§4) */}
      <div aria-live="assertive" className="pt-3 empty:pt-0">
        {phase.kind === "creating" ? (
          <p className="text-sm text-foreground">Starting new chat on {destination?.label ?? "the other backend"}…</p>
        ) : phase.kind === "checking" ? (
          <p className="text-sm text-foreground">Checking whether the new chat exists…</p>
        ) : phase.kind === "refused" ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/50 p-3 text-sm">
            <p>Couldn't start the new chat: {phase.message} Your handoff is kept.</p>
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" size="sm" block={false} style={{ minHeight: 44 }} label="Try again" onClick={start} disabled={Boolean(why)} />
              <Button tone="ghost" size="sm" block={false} style={{ minHeight: 44 }} label="Back to edit" onClick={() => root.stores.handoff.getState().setPhase({ kind: "review" })} />
            </div>
          </div>
        ) : phase.kind === "uncertain" ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
            <p>Didn't hear back. The new chat may or may not exist. Checking again won't create a second one.</p>
            <p className="font-mono text-[11px] text-muted-foreground">handoff {handoffId.slice(0, 12)}…</p>
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" size="sm" block={false} style={{ minHeight: 44 }} label="Check again" onClick={checkAgain} disabled={!connected} />
              <Button tone="ghost" size="sm" block={false} style={{ minHeight: 44 }} label="Back to edit" onClick={() => root.stores.handoff.getState().setPhase({ kind: "review" })} />
            </div>
          </div>
        ) : null}
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Nothing is sent until you start it.{why && phase.kind === "review" ? ` · ${why}` : ""}</p>
        <div className="flex gap-2 tablet:justify-end">
          <Button tone="ghost" size="md" block={false} style={{ minHeight: 44, flex: "1 1 0", width: "auto" }} label="Cancel" onClick={cancel} disabled={busy} />
          <Button tone="primary" size="md" block={false}
            style={{ minHeight: 44, flex: "1 1 0", width: "auto" }} label="Start new chat"
            onClick={start} disabled={Boolean(why) || busy || phase.kind !== "review"}
            ariaLabel={`Start new chat on ${destination?.label ?? "another backend"}`} />
        </div>
      </div>
    </div>
  );

  return (
    <Overlay open variant="dialog" size="md" title="Continue on another backend"
      subtitle="Starts a new linked chat. This one stays as it is." closeLabel="Cancel handoff"
      closedBy={busy ? "none" : "any"} initialFocus={toRef} onClose={cancel}
      returnFocus={created ? () => pointer ? document.querySelector<HTMLTextAreaElement>("[data-composer] textarea") : null : true}>
      {body}
    </Overlay>
  );
}
