import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Overlay, Button, TextButton } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { SAVING_SHOWN_AFTER_MS, draftSaveView } from "../../lib/drafts.js";
import { VERSION_SWITCH_COPY } from "../../lib/draft-indicator.js";
import { useLocalWorkStatus } from "../../hooks/use-local-work.js";
import { hasContent, holdsSnapshots, type DraftConflictChoice } from "../../stores/draft-state.js";

/**
 * The line under the composer while a draft exists (D52 §5): `draft ·
 * saved` only once the host acknowledged this exact revision, images
 * included; `draft · saving…` once a save has been out for 600ms; and the
 * honest states for a host that is unreachable, keeps no drafts, or
 * refused the size. A conflict prints `Compare`, which opens both versions.
 * Content is kept here in every state.
 */
export function DraftSaveLine({ draftId }: { draftId: string }) {
  const root = useBrainUiRoot();
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const supported = useRootStore("drafts", (s) => s.supported);
  const limits = useRootStore("drafts", (s) => s.limits);
  const localFailed = useLocalWorkStatus((s) => s.failed);
  const switchNote = useRootStore("drafts", (s) => (s.versionSwitch?.draftId === draftId && s.versionSwitch.outcome !== "unattached" ? s.versionSwitch.outcome : null));
  const [, tick] = useState(0);
  const [comparing, setComparing] = useState(false);
  const compareRef = useRef<HTMLButtonElement>(null);
  // `saving…` appears once the save has been out long enough, without another change to wait for.
  useEffect(() => {
    if (draft?.savingSince == null) return;
    const left = SAVING_SHOWN_AFTER_MS - (Date.now() - draft.savingSince);
    if (left <= 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [draft?.savingSince]);
  useEffect(() => { if (!draft?.conflict) setComparing(false); }, [draft?.conflict]);

  const view = draftSaveView(draft, { supported, limits, localFailed }, Date.now());
  const tone = view.state === "saved" ? "text-accent"
    : view.state === "conflict" || view.state === "too_large" || view.state === "full" || view.state === "refused" || view.state === "unsaved" ? "text-primary"
    : "text-muted-foreground";
  // A failed device write takes back "both versions kept", not the switch's outcome (#4567).
  if (draft?.deviceConflict && !draft.conflict && (!localFailed || switchNote)) return (
    <div className="mx-auto mt-1 flex max-w-3xl flex-wrap items-center gap-x-2 px-1 font-mono text-[10.5px] leading-4 text-foreground" data-device-conflict="">
      {localFailed ? null : <span role="status">Another tab changed this draft · Both versions kept</span>}
      {draft.failure?.kind === "refused" && draft.failure.edit === draft.edit ? <span className="text-primary" data-draft-save="refused">· not saved · refused by the brain</span> : null}
      {switchNote ? <span data-version-switch={switchNote}>{localFailed ? "" : "· "}{VERSION_SWITCH_COPY[switchNote]}</span> : null}
      <TextButton tone="inherit" label="Open other version" onClick={() => openOtherVersion(root, draft.deviceConflict!.otherId, draftId)} />
    </div>
  );
  if (view.state === "none") {
    // Absent, with no spacer, while there is no draft. A draft whose save is
    // still on its way prints nothing too, but keeps the line's place, so a
    // keystroke or a drop that turns it into `not saved yet` never moves the
    // field above it (#1013).
    if (!draft || (draft.text.length === 0 && draft.attachments.length === 0)) return null;
    return <div aria-hidden="true" className="mx-auto mt-1 h-4 max-w-3xl" data-draft-save-slot="" />;
  }
  return (
    <div className="mx-auto mt-1 flex min-h-[16px] max-w-3xl items-center gap-2 px-1 font-mono text-[10.5px] leading-4" data-draft-save={view.state} data-draft-id={draftId}>
      {view.state === "conflict" ? (
        <>
          <span className={tone}>{view.copy}</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="text-foreground">
            <TextButton ref={compareRef} tone="inherit" inline label="Compare" haspopup="dialog"
              ariaLabel="Compare drafts" onClick={() => setComparing(true)} data-draft-compare="" />
          </span>
        </>
      ) : (
        <span className={tone}>{view.copy}</span>
      )}
      {comparing && draft?.conflict ? <CompareDrafts draftId={draftId} onClose={() => setComparing(false)} returnFocus={() => compareRef.current} /> : null}
    </div>
  );
}

/** Each side's images, so two versions with the same count can still be told apart. */
function Thumbs({ urls, names }: { urls: string[]; names: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-compare-images="">
      {urls.map((url, i) => <img key={i} src={url} alt={names[i]} className="h-12 w-12 rounded-lg border border-border object-cover" />)}
    </div>
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Compare drafts (D52 §5): this device's and the other device's version,
 * each with its edit time. Keep both turns the other version into an
 * unbound Draft entry. There is no automatic or model merge.
 */
export function CompareDrafts({ draftId, onClose, returnFocus }: { draftId: string; onClose: () => void; returnFocus?: () => HTMLElement | null }) {
  const root = useBrainUiRoot();
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const heading = useRef<HTMLHeadingElement>(null);
  if (!draft?.conflict) return null;
  const other = draft.conflict.other;
  const choose = (choice: DraftConflictChoice) => {
    root.stores.drafts.getState().resolve(draftId, choice);
    onClose();
  };
  const images = (n: number) => (n > 0 ? ` · ${n} image${n === 1 ? "" : "s"}` : "");
  return createPortal(
    <Overlay open variant="dialog" size="lg" title="Compare drafts" data-compare-drafts=""
      initialFocus={heading} onClose={onClose} returnFocus={returnFocus}>
      <h2 ref={heading} tabIndex={-1} className="bk-sr-only">Compare drafts</h2>
      <section className="mb-3" data-compare-side="this">
        <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">This device · edited {clock(draft.editedAt)}{images(draft.attachments.length)}</div>
        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">{draft.text || "(images only)"}</p>
        <Thumbs urls={draft.attachments.map((a) => a.previewUrl)} names={draft.attachments.map((a) => a.name)} />
      </section>
      <section className="mb-4" data-compare-side="other">
        <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">Other device · edited {clock(other.updatedAt)}{images(other.attachments.length)}</div>
        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">{other.text || "(images only)"}</p>
        <Thumbs urls={other.attachments.map((a) => `data:${a.mime};base64,${a.bytes}`)} names={other.attachments.map((a) => a.name ?? "image")} />
      </section>
      <div className="flex flex-wrap gap-2 pb-2">
        <Button label="Keep this device's" tone="primary" size="md" block={false} onClick={() => choose("mine")} />
        <Button label="Keep other's" tone="ghost" size="md" block={false} onClick={() => choose("other")} />
        <Button label="Keep both" tone="ghost" size="md" block={false} onClick={() => choose("both")} />
      </div>
    </Overlay>,
    document.body,
  );
}

/**
 * Open the other version of a device-local keep-both branch (#1014). This
 * may wait for native storage; a later navigation owns the view, including
 * New conversation while already in a new chat, and cancels it.
 *
 * It always ends at the other version's content, or says why not (#4567):
 * a version a rotation moved is opened where it lives now; one with no
 * chat, or whose chat turns out to be gone, opens on its own in the
 * new-chat view, labelled; a cancelled or failed switch is noted on the
 * draft it left (`versionSwitch`), never an empty new chat.
 */
export function openOtherVersion(root: BrainUiRoot, otherId: string, fromId: string): void {
  const drafts = root.stores.drafts;
  drafts.getState().noteVersionSwitch(null);
  const note = (outcome: "cancelled" | "failed" | "missing") => drafts.getState().noteVersionSwitch({ draftId: fromId, outcome });
  const controller = new AbortController();
  const unwatch = [
    root.stores.chat.subscribe((s, prev) => { if (s.activeSessionId !== prev.activeSessionId) controller.abort(); }),
    drafts.subscribe((s, prev) => {
      if (s.fresh === prev.fresh || s.fresh === otherId) return;
      const continued = s.drafts[s.fresh]?.deviceConflict && s.resolveId(prev.fresh) === s.fresh;
      if (!continued) controller.abort();
    }),
    watchNavigation(root, () => controller.abort()),
  ];
  const open = async () => {
    // Read before opening too: a rotation may land while the device read is out.
    const before = drafts.getState().versionHome(otherId);
    if (root.localWork) await root.localWork.openDeviceVersion(otherId, controller.signal);
    else drafts.getState().openDeviceVersion(otherId);
    if (controller.signal.aborted) { note("cancelled"); return; }
    unwatch.forEach(stop => stop());
    // Where its content is: an emptied record the device kept under the old id is not it.
    const found = (id: string | undefined) => { const d = id ? drafts.getState().drafts[id] : undefined; return d && (hasContent(d) || holdsSnapshots(d)) ? id : undefined; };
    // A version a rotation had moved before the read is where it was moved to,
    // whatever record the device kept under the old id.
    const target = found(drafts.getState().versionHome(otherId)) ?? (before !== otherId ? found(before) : undefined) ?? found(otherId);
    if (!target) { backToBranch(root, fromId); note("missing"); return; }
    if (target !== otherId) drafts.getState().openDeviceVersion(target);
    const sessionId = drafts.getState().drafts[target]!.sessionId;
    if (sessionId === null) openUnattached(root, target);
    else {
      const changedSession = root.stores.chat.getState().activeSessionId !== sessionId;
      root.stores.chat.getState().setActiveSession(sessionId);
      if (changedSession) root.connection.send({ type: "session_resume", sessionId });
      detachIfGone(root, target, sessionId, fromId);
    }
    root.stores.ui.getState().setActiveView("chat");
  };
  void open().catch(() => { note("failed"); }).finally(() => { unwatch.forEach(stop => stop()); });
}

/** Any change of view, panel or account the reader makes. Returns the unsubscribe. */
function watchNavigation(root: BrainUiRoot, moved: () => void): () => void {
  const navigation = ["activeView", "sessionPanelOpen", "syncPanelOpen", "whatsupPanelOpen", "searchPanelOpen", "addPanelOpen", "filePanelOpen", "settingsPanelOpen", "subagentStack", "destinationPress", "panelPress", "sessionsPaneFocus"] as const;
  const stops = [
    root.stores.ui.subscribe((s, prev) => { if (navigation.some(key => s[key] !== prev[key])) moved(); }),
    root.stores.connection.subscribe((s, prev) => { if (s.accountKey !== prev.accountKey) moved(); }),
  ];
  return () => stops.forEach(stop => stop());
}

/** The reader's own branch back in view, where Open other version left it. */
function backToBranch(root: BrainUiRoot, fromId: string): void {
  const drafts = root.stores.drafts.getState();
  const from = drafts.drafts[fromId];
  if (from?.sessionId !== null || !from) return;
  const sessionId = from.deviceConflict?.sessionId ?? null;
  if (sessionId !== null) {
    drafts.showDeviceBranch(sessionId, fromId);
    if (root.stores.chat.getState().activeSessionId !== sessionId) root.stores.chat.getState().setActiveSession(sessionId);
  } else {
    // A branch of no chat is the new-chat view's: the gone chat leaves the screen with it.
    root.stores.chat.getState().clearMessages();
    root.stores.drafts.getState().openUnbound(fromId);
  }
}

/**
 * A version with no chat opens as a Draft entry does: an empty Chat with
 * that draft, a pending first message of the previous new chat set aside,
 * and the hint that it is not in a chat yet (#4567).
 */
function openUnattached(root: BrainUiRoot, draftId: string): void {
  root.stores.chat.getState().clearMessages();
  root.stores.drafts.getState().openUnbound(draftId);
  root.stores.drafts.getState().noteVersionSwitch({ draftId, outcome: "unattached" });
}

/**
 * The other version's chat may be gone, which only its restore says (#4567):
 * then the version moves off it and opens on its own in the new-chat view,
 * instead of leaving the reader on Conversation unavailable. A cached
 * transcript proves nothing about the resume just sent, and another
 * failure's Retry may still answer that it is gone, so it watches until the
 * reader moves to another chat, view, panel or account. A version holding
 * outgoing messages stays: they belong to that chat, and a draft of no chat
 * would lose them.
 */
function detachIfGone(root: BrainUiRoot, draftId: string, sessionId: string, fromId: string): void {
  const chat = root.stores.chat;
  let stopped = false;
  const stops: Array<() => void> = [];
  const stop = () => { stopped = true; stops.forEach(s => s()); };
  const check = () => {
    if (stopped) return;
    const c = chat.getState();
    if (c.activeSessionId !== sessionId) { stop(); return; }
    if (c.restoreFailures[sessionId]?.reason !== "missing") return;
    stop();
    // A refresh may have moved the version since the switch: follow it.
    const home = root.stores.drafts.getState().versionHome(draftId) ?? draftId;
    const d = root.stores.drafts.getState().drafts[home];
    // Gone with its chat (deleted elsewhere, nothing newer here): back where the reader was, saying so.
    if (!d) { backToBranch(root, fromId); root.stores.drafts.getState().noteVersionSwitch({ draftId: fromId, outcome: "missing" }); return; }
    if (d.sessionId === null) { openUnattached(root, home); return; }
    if (d.sessionId !== sessionId) return;
    const detached = root.stores.drafts.getState().detachVersion(home);
    // Only outgoing messages, and they stay with the gone chat: back to the branch, saying so.
    if (!detached) { backToBranch(root, fromId); root.stores.drafts.getState().noteVersionSwitch({ draftId: fromId, outcome: "chat_gone" }); return; }
    if (detached) openUnattached(root, detached);
  };
  stops.push(chat.subscribe(check), watchNavigation(root, stop));
  check();
}
