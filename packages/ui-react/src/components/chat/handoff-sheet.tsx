import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BottomSheet, Label } from "@schlessera/brain-ui-kit";
import {
  composeHandoffText,
  HANDOFF_DRAFT_MESSAGES,
  HANDOFF_MAX_CHARS,
  HANDOFF_MAX_REFERENCES,
  type ProviderInfo,
} from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useHandoffStore } from "../../stores/handoff-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { useOpenSession } from "../../hooks/use-open-session.js";
import { deterministicDraft, snapshotSource, suggestedReferences, type HandoffSnapshot } from "../../lib/handoff.js";
import { detectClientEnvironment } from "../../lib/client-environment.js";
import { cn } from "../../lib/utils.js";

/** How long the sheet waits for an unloaded source's history. */
const HISTORY_WAIT_MS = 5000;
/** How long a send may go unacknowledged before it reads as uncertain. */
const ACK_WAIT_MS = 15000;

type ReferenceState = "checking" | "readable" | "missing" | "unreadable";
interface Reference {
  path: string;
  state: ReferenceState;
}
type Origin = "deterministic" | "model" | "user" | "none";

const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BUTTON} border-transparent bg-primary-fill text-primary-foreground hover:brightness-110`;
const GHOST = `${BUTTON} border-border bg-transparent text-foreground hover:bg-surface-raised`;
const LINKISH = "inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

/** Where a choice of destination profile stands. */
function destinationWhy(profile: ProviderInfo | undefined, connected: boolean): string | undefined {
  if (!connected) return "host offline";
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
  if (!sheet) return null;
  // Keyed by the review: a new open is a new review with its own key.
  return <HandoffReview key={sheet.handoffId} sourceSessionId={sheet.sourceSessionId} handoffId={sheet.handoffId} send={(m) => root.connection.send(m)} />;
}

function HandoffReview({ sourceSessionId, handoffId, send }: {
  sourceSessionId: string;
  handoffId: string;
  send: (message: import("@schlessera/brain-ui-sdk/protocol").ClientMessage) => boolean | void;
}) {
  const root = useBrainUiRoot();
  const titleId = useId();
  const pointer = useMediaQuery("(min-width: 900px)");
  const openSession = useOpenSession();
  const dialogRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLSelectElement>(null);
  const returnFocus = useRef<HTMLElement | null>(typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null));

  const handoff = useHandoffStore((s) => s);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const providers = useProviderStore((s) => s.available);
  const backends = useProviderStore((s) => s.backends);
  const pinnedId = useProviderStore((s) => s.pinnedId);
  const sourceBackendId = useChatStore((s) => s.backendIds[sourceSessionId]);
  const source = useChatStore((s) => s.buffers[sourceSessionId]);
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  const sourceProfile = providers.find((p) => p.id === pinnedId && activeSessionId === sourceSessionId)
    ?? providers.find((p) => p.backendId === sourceBackendId);
  const sourceName = sourceProfile?.label ?? sourceBackendId ?? "this chat's model";
  const destinations = useMemo(
    () => providers.filter((p) => p.backendId && p.backendId !== sourceBackendId),
    [providers, sourceBackendId]
  );
  const canSummarize = Boolean(sourceBackendId && backends[sourceBackendId]?.capabilities.autonomous);

  const [destinationId, setDestinationId] = useState<string>(() => destinations[0]?.id ?? "");
  const destination = destinations.find((p) => p.id === destinationId);
  const [snapshot, setSnapshot] = useState<HandoffSnapshot | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [text, setText] = useState("");
  const [origin, setOrigin] = useState<Origin>("none");
  const [references, setReferences] = useState<Reference[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<null | { text: string; origin: Origin }>(null);

  // --- Snapshot, at open (§3): the latest settled turn, once history is here.
  useEffect(() => {
    if (snapshot || historyError) return;
    if (source && source.messages.length > 0) {
      setSnapshot(snapshotSource(source));
      return;
    }
    const timer = setTimeout(() => setHistoryError(true), HISTORY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [source, snapshot, historyError]);

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
  function prepare(messageCount: number) {
    if (!canSummarize) return;
    const prepareId = `${handoffId}-p${++runs.current}`;
    running.current = prepareId;
    root.stores.handoff.getState().startPrepare(prepareId);
    if (send({ type: "handoff_prepare", handoffId: prepareId, sourceSessionId, messageCount }) === false) {
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
    prepare(snapshot.messages.length);
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

  // Leaving with the run still going stops it: nobody is left to read it.
  useEffect(() => () => {
    if (running.current) send({ type: "handoff_prepare_cancel", handoffId: running.current });
  }, [send]);

  // --- Focus: the To select on open; trapped while open; back to the opener on close.
  useEffect(() => {
    (toRef.current ?? dialogRef.current?.querySelector<HTMLElement>("textarea"))?.focus();
    return () => {
      const opener = returnFocus.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // --- Created: open the destination; the source is untouched.
  const created = handoff.created;
  useEffect(() => {
    if (!created) return;
    const store = root.stores.handoff.getState();
    const sent = store.pendingSend;
    const backendId = providers.find((p) => p.id === (sent?.providerId ?? destinationId))?.backendId;
    store.addLink(
      sourceSessionId,
      { sessionId: created.sessionId, title: null, ...(backendId ? { backendId } : {}), ...(snapshot ? { afterMessages: source?.messages.length ?? snapshot.messages.length } : {}) },
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
    returnFocus.current = null;
    store.close();
    // Desktop: the destination's composer. A phone keeps the keyboard down.
    if (pointer) setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus(), 0);
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
  const settledNow = source ? snapshotSource(source).messages.length : 0;
  const newSince = snapshot ? Math.max(0, settledNow - snapshot.messages.length) : 0;
  function refreshDraft() {
    if (!source) return;
    stopSummary();
    setSnapshot(snapshotSource(source));
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
    : destinationWhy(destination, connected)
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

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (e.key !== "Tab") return;
    const stops = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]'
    ) ?? [])];
    const first = stops[0];
    const last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
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

  const body = (
    <div ref={dialogRef} onKeyDown={onKeyDown} className="flex max-h-[min(80vh,720px)] flex-col gap-4 overflow-y-auto">
      {!pointer ? null : (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="font-[family-name:var(--font-display)] text-lg text-foreground">Continue on another backend</h2>
            <p className="mt-1 text-xs text-muted-foreground">Starts a new linked chat. This one stays as it is.</p>
          </div>
          <button type="button" className={cn(GHOST, "w-11 px-0")} aria-label="Cancel handoff" onClick={cancel} disabled={busy}>×</button>
        </div>
      )}

      {/* To */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${titleId}-to`}><Label text="To" /></label>
        {destinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other backend is set up on this host.</p>
        ) : (
          <select
            id={`${titleId}-to`}
            ref={toRef}
            value={destinationId}
            disabled={busy}
            onChange={(e) => setDestinationId(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {destinations.map((p) => (
              <option key={p.id} value={p.id} disabled={!connected}>
                {p.label} · {p.backendId}{p.billingMode === "api" ? " · spends" : ""}{!connected ? " — host offline" : ""}
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
          rows={pointer ? 9 : 7}
          aria-busy={draft.state === "running" || undefined}
          aria-describedby={`${titleId}-source`}
          className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        />
        <div id={`${titleId}-source`} className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-muted-foreground" aria-live="polite">
          <span className={cn("font-mono", draft.state === "running" && "animate-pulse")}>{draftLabel}</span>
          {draft.state === "running" ? (
            <button type="button" className={LINKISH} onClick={stopSummary}>Stop</button>
          ) : null}
        </div>
        {draftNote ? <p className="text-[11px] text-muted-foreground">{draftNote}</p> : null}
        {confirmReplace ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
            <span className="flex-1">Replace your edits?</span>
            <button type="button" className={GHOST} onClick={() => setConfirmReplace(null)}>Keep mine</button>
            <button type="button" className={PRIMARY} onClick={() => { setText(confirmReplace.text); setOrigin(confirmReplace.origin); setConfirmReplace(null); }}>Replace</button>
          </div>
        ) : null}
        {snapshot?.running ? (
          <p className="text-xs text-muted-foreground">A reply is still running here. It isn't included, and it keeps running.</p>
        ) : null}
        {newSince > 0 ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span>{newSince === 1 ? "1 new message" : `${newSince} new messages`} since you opened this ·</span>
            <button type="button" className={LINKISH} onClick={refreshDraft} disabled={busy}>Refresh draft</button>
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
                <button
                  type="button"
                  className="inline-flex h-11 w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={`Remove reference ${r.path}`}
                  disabled={busy}
                  onClick={() => setReferences((current) => current.filter((x) => x.path !== r.path))}
                >×</button>
              </li>
            );
          })}
          <li>
            {adding === null ? (
              <button type="button" className={LINKISH} disabled={busy || references.length >= HANDOFF_MAX_REFERENCES} onClick={() => setAdding("")}>+ add a file</button>
            ) : (
              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); checkReference(adding); setAdding(null); }}>
                <input
                  autoFocus
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAdding(null); } }}
                  placeholder="plans/ithaca.md"
                  aria-label="Brain file path"
                  className="min-h-11 w-44 rounded-md border border-border bg-background px-2 font-mono text-xs"
                />
                <button type="submit" className={GHOST}>Add</button>
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

      {/* Outcome of Start new chat (§4) */}
      <div aria-live="assertive">
        {phase.kind === "creating" ? (
          <p className="text-sm text-foreground">Starting new chat on {destination?.label ?? "the other backend"}…</p>
        ) : phase.kind === "checking" ? (
          <p className="text-sm text-foreground">Checking whether the new chat exists…</p>
        ) : phase.kind === "refused" ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/50 p-3 text-sm">
            <p>Couldn't start the new chat: {phase.message} Your handoff is kept.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} onClick={start} disabled={Boolean(why)}>Try again</button>
              <button type="button" className={GHOST} onClick={() => root.stores.handoff.getState().setPhase({ kind: "review" })}>Back to edit</button>
            </div>
          </div>
        ) : phase.kind === "uncertain" ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
            <p>Didn't hear back. The new chat may or may not exist. Checking again won't create a second one.</p>
            <p className="font-mono text-[11px] text-muted-foreground">handoff {handoffId.slice(0, 12)}…</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} onClick={checkAgain} disabled={!connected}>Check again</button>
              <button type="button" className={GHOST} onClick={() => root.stores.handoff.getState().setPhase({ kind: "review" })}>Back to edit</button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Nothing is sent until you start it.{why && phase.kind === "review" ? ` · ${why}` : ""}</p>
        <div className="grid grid-cols-2 gap-2 tablet:flex tablet:justify-end">
          <button type="button" className={GHOST} onClick={cancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={PRIMARY}
            onClick={start}
            disabled={Boolean(why) || busy || phase.kind !== "review"}
            aria-label={`Start new chat on ${destination?.label ?? "another backend"}`}
          >
            Start new chat
          </button>
        </div>
      </div>
    </div>
  );

  const surface = pointer ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
    >
      <div className="w-[480px] max-w-full rounded-xl border border-border bg-surface p-5 shadow-[0_16px_48px_rgba(0,0,0,0.5)]">{body}</div>
    </div>
  ) : (
    <div
      className="fixed inset-0 z-[60] bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="absolute inset-x-0 bottom-0">
        <BottomSheet title="Continue on another backend" subtitle="Starts a new linked chat. This one stays as it is." docked>
          <span id={titleId} className="sr-only">Continue on another backend</span>
          {body}
        </BottomSheet>
      </div>
    </div>
  );
  return surface;
}
