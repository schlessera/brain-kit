import { useRef } from "react";
import { createPortal } from "react-dom";
import { Overlay, Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { hasContent, holdsSnapshots, type DraftConflictChoice } from "../../stores/draft-state.js";
import { clockTime } from "../../lib/format-time.js";

/** Each side's images, so two versions with the same count can still be told apart. */
function Thumbs({ urls, names }: { urls: string[]; names: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-compare-images="">
      {urls.map((url, i) => <img key={i} src={url} alt={names[i]} className="h-12 w-12 rounded-lg border border-border object-cover" />)}
    </div>
  );
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
        <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">This device · edited {clockTime(draft.editedAt)}{images(draft.attachments.length)}</div>
        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">{draft.text || "(images only)"}</p>
        <Thumbs urls={draft.attachments.map((a) => a.previewUrl)} names={draft.attachments.map((a) => a.name)} />
      </section>
      <section className="mb-4" data-compare-side="other">
        <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">Other device · edited {clockTime(other.updatedAt)}{images(other.attachments.length)}</div>
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
  // Said on the branch as it is then: a fork during the read may have moved it to a new id.
  const note = (outcome: "cancelled" | "failed" | "missing") => drafts.getState().noteVersionSwitch({ draftId: drafts.getState().resolveId(fromId), outcome });
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
      // The view changes first: the watcher ends only on the reader's own later navigation.
      root.stores.ui.getState().setActiveView("chat");
      detachIfGone(root, target, sessionId, fromId);
      return;
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
/**
 * `gone`: a chat just found missing, never returned to. The branch is
 * followed to the id it lives under now (a fork may have moved it). Returns
 * that id, for the note.
 */
function backToBranch(root: BrainUiRoot, branchId: string, gone?: string): string {
  const drafts = root.stores.drafts.getState();
  const fromId = drafts.resolveId(branchId);
  const from = drafts.drafts[fromId];
  if (!from) return fromId;
  const chat = root.stores.chat.getState();
  const show = (sessionId: string) => {
    if (chat.activeSessionId === sessionId) return;
    chat.setActiveSession(sessionId);
    root.connection.send({ type: "session_resume", sessionId });
  };
  // A branch that gained its own chat since: that chat.
  if (from.sessionId !== null && from.sessionId !== gone) { show(from.sessionId); return fromId; }
  const sessionId = from.deviceConflict?.sessionId ?? null;
  if (sessionId !== null && sessionId !== gone) {
    drafts.showDeviceBranch(sessionId, fromId);
    show(sessionId);
    return fromId;
  }
  // Already in view: nothing to change, and the new chat's transcript stays.
  if (chat.activeSessionId === null && drafts.fresh === fromId) return fromId;
  // A branch of no chat (or of the chat that is gone) is the new-chat view's: the chat on screen leaves with it.
  if (chat.activeSessionId !== null) chat.clearMessages();
  if (from.sessionId === null) root.stores.drafts.getState().openUnbound(fromId);
  return fromId;
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
    if (!d) { const at = backToBranch(root, fromId, sessionId); root.stores.drafts.getState().noteVersionSwitch({ draftId: at, outcome: "missing" }); return; }
    if (d.sessionId === null) { openUnattached(root, home); return; }
    if (d.sessionId !== sessionId) return;
    const detached = root.stores.drafts.getState().detachVersion(home);
    // Only outgoing messages, and they stay with the gone chat: back to the branch, saying so.
    if (!detached) { const at = backToBranch(root, fromId, sessionId); root.stores.drafts.getState().noteVersionSwitch({ draftId: at, outcome: "chat_gone" }); return; }
    if (detached) openUnattached(root, detached);
  };
  stops.push(chat.subscribe(check), watchNavigation(root, stop));
  check();
}
