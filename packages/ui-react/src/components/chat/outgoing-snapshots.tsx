import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button, Overlay, StatusIndicator, type StatusIndicatorState } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { draftFiles, draftSnapshots, type ComposerDraft, type ComposerSnapshot, type DraftSend } from "../../stores/draft-state.js";
import { dropSnapshotUploads, filesFor } from "../../lib/draft-files.js";
import { trackKey } from "../../lib/draft-tracks.js";
import { UserTurn } from "./transcript-turn.js";

/**
 * Outgoing snapshots as bubbles in the transcript (#3155, design brief rev 5
 * §2–§4, G2 A). Each one is a send that is held, returned unsent or not yet
 * confirmed, drawn after the last accepted message in creation order, with
 * its own status indicator and its own actions, all keyed by `snapshotId`.
 *
 * - A dispatched snapshot whose message this tab has sent and is waiting on
 *   is the transcript's own row, as every send is: it is not drawn twice.
 * - Only the chat in view: a snapshot belongs to its origin draft, and a
 *   session switch neither moves nor sends it.
 * - Focus moves only on the reader's own action. A background change (an
 *   upload not stored, a send unconfirmed) is announced once, politely, and
 *   leaves focus where it is.
 */
type BubbleKind = "held" | "paused" | "cancelled" | "failed" | "refused" | "returned" | "sending" | "unconfirmed";

interface Bubble {
  d: ComposerDraft;
  s: ComposerSnapshot;
  kind: BubbleKind;
  send?: DraftSend;
}

const TONE: Record<BubbleKind, StatusIndicatorState> = {
  held: "queued", paused: "attention", cancelled: "attention", returned: "attention", failed: "failed", refused: "refused", sending: "active", unconfirmed: "unknown",
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function head(b: Bubble): string {
  switch (b.kind) {
    case "held": {
      const n = b.s.uploads?.length ?? 0;
      return n > 0 ? `Held · sends when ${n} ${plural(n, "file is", "files are")} stored` : "Held · sends when its files are stored";
    }
    case "paused": return "Paused after reload · files stored";
    case "cancelled": return "Not sent · cancelled";
    case "failed": case "refused": case "returned": return "Not sent";
    case "sending": return "Sending…";
    case "unconfirmed": return "Couldn't confirm this was sent";
  }
}

function kindOf(s: ComposerSnapshot, send: DraftSend | undefined): BubbleKind | null {
  if (s.retiring) return null;
  if (s.state === "held") return s.paused ? "paused" : "held";
  if (s.state === "returned") return s.why?.kind === "cancelled" ? "cancelled" : s.why?.kind ?? "returned";
  if (send?.state === "unconfirmed") return "unconfirmed";
  // Waiting on the host's answer: the transcript's row stands for it.
  if (send?.state === "pending") return null;
  return "sending";
}

/** Bubbles that need the reader: what Show reaches when the chat is full. */
const NEEDS_ACTION = new Set<BubbleKind>(["held", "paused", "cancelled", "failed", "refused", "returned", "unconfirmed"]);

/**
 * Show, from the composer's queue-full notice: scroll to the oldest snapshot
 * that needs action and focus its heading. False when none is drawn.
 */
export function focusOldestSnapshot(scope: ParentNode = document): boolean {
  const heading = scope.querySelector<HTMLElement>("[data-outgoing-snapshot][data-needs-action] [data-snapshot-heading]");
  if (!heading) return false;
  heading.scrollIntoView({ block: "center" });
  heading.focus({ preventScroll: true });
  return true;
}

const composerField = () => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea");
const headingOf = (snapshotId: string) => document.querySelector<HTMLElement>(`[data-outgoing-snapshot="${CSS.escape(snapshotId)}"] [data-snapshot-heading]`);

export function OutgoingSnapshots() {
  const root = useBrainUiRoot();
  const sessionId = useChatStore((s) => s.activeSessionId);
  const on = useRootStore("drafts", (s) => s.snapshotsOn);
  const drafts = useRootStore("drafts", (s) => s.drafts);
  const sends = useRootStore("drafts", (s) => s.sends);
  const fresh = useRootStore("drafts", (s) => s.fresh);
  const viewId = useRootStore("drafts", (s) => s.idFor(sessionId));
  const reviewText = useVoiceStore((s) => s.reviewText);
  const [announcement, setAnnouncement] = useState("");
  const [deleting, setDeleting] = useState<{ draftId: string; snapshotId: string } | null>(null);
  // The composer's own uploads decide whether it is empty, so Edit follows them.
  const origin = useRootStore("drafts", (s) => s.originOf(viewId));
  const queue = filesFor(root, trackKey(sessionId, origin), sessionId);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { queue.listeners.add(rerender); return () => { queue.listeners.delete(rerender); }; }, [queue]);

  // Every snapshot of this chat with what it is now, drawn or not: a send
  // waiting on its answer is not drawn, and its move to unconfirmed is news.
  const kinds = useMemo(() => {
    const map = new Map<string, BubbleKind | "pending">();
    if (!on) return map;
    for (const d of Object.values(drafts)) {
      if (sessionId === null ? d.draftId !== fresh : d.sessionId !== sessionId) continue;
      for (const s of draftSnapshots(d)) map.set(s.snapshotId, kindOf(s, sends[s.requestId]) ?? "pending");
    }
    return map;
  }, [on, drafts, sends, sessionId, fresh]);
  const bubbles = useMemo<Bubble[]>(() => {
    if (!on) return [];
    const own = Object.values(drafts).filter((d) => (sessionId === null ? d.draftId === fresh : d.sessionId === sessionId));
    const list: Bubble[] = [];
    for (const d of own) {
      for (const s of draftSnapshots(d)) {
        const send = sends[s.requestId];
        const kind = kindOf(s, send);
        if (kind) list.push({ d, s, kind, ...(send ? { send } : {}) });
      }
    }
    // Creation order across this chat's drafts; one not yet acknowledged is newest.
    return list.map((b, i) => ({ b, i })).sort((x, y) => ((x.b.s.createdAt ?? Infinity) - (y.b.s.createdAt ?? Infinity)) || x.i - y.i).map((x) => x.b);
  }, [on, drafts, sends, sessionId, fresh]);

  // Background changes, announced once each; the first look at a chat says nothing.
  const seen = useRef<Map<string, BubbleKind | "pending"> | null>(null);
  const userAction = useRef(new Set<string>());
  useEffect(() => { seen.current = null; }, [sessionId]);
  useEffect(() => {
    const before = seen.current;
    seen.current = kinds;
    if (!before) return;
    const notStored: string[] = [];
    let unconfirmed = 0;
    for (const b of bubbles) {
      const was = before.get(b.s.snapshotId);
      if (was === b.kind || userAction.current.has(b.s.snapshotId)) continue;
      if ((b.kind === "failed" || b.kind === "refused") && (was === "held" || was === "sending" || was === "pending" || was === undefined)) notStored.push(b.s.why && "file" in b.s.why && b.s.why.file ? b.s.why.file : "");
      if (b.kind === "unconfirmed" && (was === "pending" || was === "sending")) unconfirmed++;
    }
    userAction.current.clear();
    const parts: string[] = [];
    if (notStored.length) {
      const named = notStored.filter(Boolean);
      parts.push(`${notStored.length} ${plural(notStored.length, "message", "messages")} not sent${named.length ? `: ${named.join(", ")} ${plural(named.length, "wasn't", "weren't")} stored` : ""}.`);
    }
    if (unconfirmed) parts.push(unconfirmed === 1 ? "Couldn't confirm a message was sent." : `Couldn't confirm ${unconfirmed} messages were sent.`);
    if (parts.length) setAnnouncement(parts.join(" "));
  }, [kinds, bubbles]);

  if (!on) return null;
  const view = drafts[viewId];
  const composerEmpty = !(view && (view.text.length > 0 || view.attachments.length > 0 || draftFiles(view).length > 0))
    && !reviewText.trim() && !queue.queue.files.some((item) => !item.snapshotId);
  const total = bubbles.length;
  const deletingBubble = deleting && bubbles.find((b) => b.s.snapshotId === deleting.snapshotId);
  const fileCount = deletingBubble ? deletingBubble.s.files.length : 0;

  return (
    <div data-outgoing-snapshots="">
      <div className="sr-only" aria-live="polite" data-snapshot-announcement="">{announcement}</div>
      {bubbles.map((b, i) => (
        <SnapshotBubble key={b.s.snapshotId} bubble={b} index={i} total={total} composerEmpty={composerEmpty}
          onUserAction={(id, said) => { userAction.current.add(id); if (said) setAnnouncement(said); }}
          onDelete={() => setDeleting({ draftId: b.d.draftId, snapshotId: b.s.snapshotId })} />
      ))}
      {deleting && deletingBubble && (
        <Overlay open variant="dialog" size="md" title="Delete this unsent message?" data-snapshot-delete=""
          returnFocus={() => headingOf(deleting.snapshotId)} onClose={() => setDeleting(null)}>
          <div className="text-sm text-foreground">
            <p>{fileCount > 0
              ? `Delete this unsent message and its ${fileCount} ${plural(fileCount, "file", "files")}? ${plural(fileCount, "It stays", "They stay")} on this brain for 7 days, then ${plural(fileCount, "is", "are")} removed.`
              : "Delete this unsent message?"}</p>
            <div className="mt-4 flex flex-wrap justify-end gap-4">
              <Button tone="ghost" size="md" block={false} reach label="Keep it" onClick={() => setDeleting(null)} />
              <Button tone="danger" size="md" block={false} reach label="Delete" onClick={() => {
                // Focus goes to the next snapshot's heading, else the composer (rev 5 §3).
                const at = bubbles.findIndex((x) => x.s.snapshotId === deleting.snapshotId);
                const next = bubbles[at + 1] ?? null;
                userAction.current.add(deleting.snapshotId);
                root.stores.drafts.getState().deleteSnapshot(deleting.draftId, deleting.snapshotId);
                setAnnouncement("Unsent message deleted.");
                setDeleting(null);
                setTimeout(() => {
                  const target = next ? headingOf(next.s.snapshotId) : null;
                  if (target) target.focus();
                  else { const field = composerField(); field?.focus(); field?.setSelectionRange(field.value.length, field.value.length); }
                }, 0);
              }} />
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function SnapshotBubble({ bubble: b, index, total, composerEmpty, onUserAction, onDelete }: {
  bubble: Bubble; index: number; total: number; composerEmpty: boolean;
  onUserAction: (snapshotId: string, announce?: string) => void; onDelete: () => void;
}) {
  const root = useBrainUiRoot();
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const heading = useRef<HTMLHeadingElement>(null);
  const { s, d, kind, send } = b;
  const label = head(b);
  const headingId = `snapshot-${s.snapshotId}`;
  const why = s.why && s.why.kind !== "cancelled" ? `${s.why.file ? `${s.why.file}: ` : ""}${s.why.reason}` : undefined;
  const checked = send?.checked === "cant_check" ? `Can't check · ${send.checkReason ?? "host unreachable"}` : send?.checked === "checking" ? "Checking…" : null;
  const named = s.files.filter((f) => f.file);
  const unnamed = s.files.length - named.length;
  const editWhy = composerEmpty ? undefined : "Edit opens when the composer is empty.";

  const cancel = () => {
    // Cancel never needs a free slot: it changes this snapshot in place (rev 5 §2).
    onUserAction(s.snapshotId, "Not sent. Kept as its own message.");
    dropSnapshotUploads(root, s.snapshotId);
    root.stores.drafts.getState().patchSnapshot(d.draftId, s.snapshotId, { state: "returned", why: { kind: "cancelled" }, uploads: [], paused: false });
    heading.current?.focus();
  };
  const edit = () => {
    if (!composerEmpty) return;
    onUserAction(s.snapshotId);
    if (!root.stores.drafts.getState().editSnapshot(d.draftId, s.snapshotId)) return;
    // The text is in the field now: the caret goes to its end.
    setTimeout(() => {
      const field = composerField();
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }, 0);
  };

  return (
    <section className="py-4" aria-labelledby={headingId} data-outgoing-snapshot={s.snapshotId} data-snapshot-kind={kind}
      {...(NEEDS_ACTION.has(kind) ? { "data-needs-action": "" } : {})}>
      <div className="mb-2 flex items-center gap-3">
        <h3 id={headingId} ref={heading} tabIndex={-1} data-snapshot-heading=""
          className="min-w-0 flex-1 font-[family-name:var(--font-mono)] text-xs font-semibold uppercase tracking-widest text-primary/80">{label}</h3>
        <StatusIndicator label={`Message ${index + 1} of ${total}`} summary={why ? `${label}: ${why}` : label} title="Unsent message" announce={false}
          returnFocus={() => heading.current}
          operations={[{ id: s.snapshotId, state: TONE[kind], stateLabel: label, ...(why ? { explanation: why } : {}),
            facts: [{ key: "Files", value: String(s.files.length) }] }]} />
      </div>
      <UserTurn>
        {named.length > 0 && <ul className="grid gap-1 text-xs text-muted-foreground" data-snapshot-files="">
          {named.map((f) => <li key={f.fileId}>{f.file!.incomingName || f.file!.name}</li>)}
        </ul>}
        {unnamed > 0 && <p className="text-xs text-muted-foreground">{named.length ? `+ ${unnamed} more` : `${unnamed} ${plural(unnamed, "file", "files")}`}</p>}
        {s.text && <div className="chat-message-body text-sm leading-relaxed text-foreground whitespace-pre-wrap">{s.text}</div>}
      </UserTurn>
      {why && <p className="mt-2 text-right text-[13px] leading-5 text-muted-foreground" data-snapshot-why="">{why}</p>}
      {checked && <p className="mt-1 text-right font-[family-name:var(--font-mono)] text-[10.5px] text-muted-foreground" role="status">{checked}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-4" data-snapshot-actions="">
        {kind === "paused" && <Button label="Send" tone="primary" size="md" block={false} reach ariaDisabled={!connected}
          {...(!connected ? { subtitle: "needs the host" } : {})}
          onClick={() => { if (connected) { onUserAction(s.snapshotId); root.connection.drafts.sendPaused(d.draftId, s.snapshotId); } }} />}
        {(kind === "held" || kind === "paused") && <Button label="Cancel" tone="ghost" size="md" block={false} reach onClick={cancel} />}
        {(kind === "cancelled" || kind === "failed" || kind === "refused" || kind === "returned") && <>
          <Button label="Edit" tone="ghost" size="md" block={false} reach ariaDisabled={!composerEmpty}
            {...(editWhy ? { subtitle: editWhy } : {})} onClick={edit} />
          <Button label="Delete…" tone="ghost" size="md" block={false} reach onClick={onDelete} />
        </>}
        {kind === "unconfirmed" && send && <>
          <Button label="Check" tone="primary" size="md" block={false} reach ariaDisabled={send.checked === "checking"}
            onClick={() => { if (send.checked !== "checking") void root.connection.drafts.check(send.requestId); }} />
          <Button label="Send again" tone="ghost" size="md" block={false} reach ariaDisabled={!connected}
            subtitle={connected ? "could post it twice" : "needs the host"}
            onClick={() => { if (connected) { onUserAction(s.snapshotId); root.connection.drafts.resendSnapshot(send.requestId); } }} />
        </>}
      </div>
    </section>
  );
}
