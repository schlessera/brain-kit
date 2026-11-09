import { COMPOSER_FILES_CAPABILITY, type ClientMessage, type Draft, type ServerMessage, type SessionDraftLimits } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { createDraftApi, type DraftApi, type DraftCallResult } from "./draft-api.js";
import { bindableFiles, draftSnapshots, hasContent, holdsSnapshots, snapshotSaveList, type ComposerDraft, type ComposerSnapshot, type DraftSend } from "../stores/draft-state.js";
import { detectClientEnvironment } from "./client-environment.js";
import { restorationOf } from "../stores/chat-state.js";
import type { PendingAttachment } from "./image-attachments.js";
import { moveTracks, removeTracks, trackKey } from "./draft-tracks.js";

/** How long a Check again may wait for the host before it counts as unreachable. */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * Keeps one root's drafts (D52 §5, #951) in step with the host and with the
 * messages sent from them.
 *
 * - **Saving.** Only a host that advertises `capabilities.sessionDrafts`
 *   is asked. A changed draft is saved after a pause, images uploaded first,
 *   under If-Match of the revision it last acknowledged; a draft emptied by
 *   the reader is deleted at that revision. A refusal is never reported as
 *   a save, and nothing local is dropped because of one.
 * - **Restoring.** Every hello, and every return to the page, lists the
 *   host's drafts: a newer version replaces a clean draft and is a conflict
 *   on a dirty one, and a draft another device deleted goes only if nothing
 *   here is newer.
 * - **Sends.** The host's acceptance, refusal or silence settles exactly
 *   the request it names. Nothing is sent again without the reader's
 *   Send again.
 *
 * Every call is an authenticated data operation: none sends a message,
 * starts a turn, answers a question or grants anything.
 */

/** A pause in typing before a change is saved. */
const SAVE_DELAY_MS = 800;
/**
 * While a chat is full of outgoing snapshots, how often a visible tab asks the
 * host whether another tab or device freed a slot (#3155, maintainer ruling A
 * of 2026-11-08: a bounded re-read; there is no draft change frame).
 */
const FULL_RECHECK_MS = 15_000;
/** Backoff for a save that got no answer or a transient refusal. */
const RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/** Errors the host sends for a frame it could not tie to a request, when they name none. */
const UNCORRELATED = ["RATE_LIMITED", "PARSE_ERROR", "INTERNAL_ERROR"];

interface DraftClientOptions {
  send: (msg: ClientMessage) => boolean;
  api?: DraftApi;
}

export function createDraftClient(root: BrainUiServices, options: DraftClientOptions) {
  const drafts = root.stores.drafts;
  const chat = root.stores.chat;
  const api = options.api ?? createDraftApi(root.apiBase, root.request);
  let disposed = false;
  /** Drafts with a call in flight: one at a time per draft. */
  const busy = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  /** Idempotency keys per draft for the save in flight: a retry of the same body reuses it. */
  const saveKeys = new Map<string, { body: string; key: string }>();
  const uploadKeys = new WeakMap<PendingAttachment, Map<string, string>>();
  /** Bumped whenever a draft's host copy changes, so a list read before it cannot judge it. */
  const hostSeq = new Map<string, number>();
  /** A device fork replaces an entry with another writer's retained version. */
  const deviceSeq = new Map<string, number>();
  let listing = false;

  const key = () => crypto.randomUUID();
  const live = () => !disposed && drafts.getState().supported === true;

  function schedule(draftId: string, delay = SAVE_DELAY_MS) {
    if (!live()) return;
    clearTimeout(timers.get(draftId));
    timers.set(draftId, setTimeout(() => { timers.delete(draftId); void sync(draftId); }, delay));
  }

  /**
   * A send's snapshot step (#3155): saved at once, without waiting for a
   * timer, so pressing Send reaches the host as directly as the frame did
   * before snapshots. Only send steps use it; typing keeps its pause and
   * retries keep their backoff.
   */
  function soon(draftId: string) {
    if (!live()) return;
    clearTimeout(timers.get(draftId));
    timers.delete(draftId);
    queueMicrotask(() => { void sync(draftId); });
  }

  function backoff(draftId: string) {
    const n = failures.get(draftId) ?? 0;
    failures.set(draftId, n + 1);
    schedule(draftId, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
  }

  /** The draft needs a call: different from what the host acknowledged, or owed a bind or a delete. */
  function owed(d: ComposerDraft): boolean {
    if (d.deviceOnly || d.conflict) return false;
    if (d.failure && d.failure.kind !== "unsaved") return false;
    if (d.bind) return true;
    // A snapshot's send is out: acceptance releases it without a revision,
    // so a save made meanwhile could list it again (#3733). It waits.
    if (sendingSnapshot(d.draftId)) return false;
    if (!hasContent(d) && !holdsSnapshots(d)) return (d.host !== null || d.uncertain) && !held(d.draftId);
    return d.host === null || d.host.edit !== d.edit;
  }

  function sendingSnapshot(draftId: string): boolean {
    const store = drafts.getState();
    return Object.values(store.sends).some((s) => s.snapshotId && s.state === "pending" && store.sendDraftId(s.requestId) === draftId);
  }

  function held(draftId: string): boolean {
    return Object.values(drafts.getState().sends).some((s) => (s.draftId === draftId || drafts.getState().sendDraftId(s.requestId) === draftId) && (s.state === "pending" || s.state === "unconfirmed"));
  }

  function bumpHost(draftId: string) { hostSeq.set(draftId, (hostSeq.get(draftId) ?? 0) + 1); }

  /**
   * A failed call's meaning for the draft. `edit` is the generation the
   * call carried: a size or capacity refusal of an older edit says nothing
   * about the content now, which is tried again instead.
   */
  function failed(draftId: string, result: Exclude<DraftCallResult<unknown>, { ok: true }>, edit?: number): void {
    const body = result.body;
    const store = drafts.getState();
    if ((result.status === 413 || result.status === 507) && edit !== undefined && store.drafts[draftId]?.edit !== edit) {
      schedule(draftId, 0);
      return;
    }
    if (result.status === 409 && body.error === "DRAFT_CONFLICT" && body.current) {
      // A revision this tab already accounts for (the host kept the row at
      // the next revision after accepting a snapshot's send): save again over it.
      const known = store.drafts[draftId]?.host?.revision;
      if (store.snapshotsOn && known !== undefined && (body.current as Draft).revision <= known) { schedule(draftId, 0); return; }
      store.conflictWith(draftId, body.current as Draft, true);
      return;
    }
    if (result.status === 409 && body.error === "DRAFT_OUTGOING_FULL") {
      // Nothing was stored and nothing sent (rev 5 §2): the new snapshots
      // come back to the composer, and the chat shows the queue-full notice.
      const d = store.drafts[draftId];
      const acked = new Set((d?.host?.snapshots ?? []).map((x) => x.snapshotId));
      const created = draftSnapshots(d).filter((x) => !acked.has(x.snapshotId) && !x.retiring && !x.replaces).map((x) => x.snapshotId);
      if (created.length > 0) store.snapshotsRefused(draftId, created, Number(body.limit) || store.limits.maxOutgoingSnapshots || 10);
      else backoff(draftId);
      return;
    }
    if (result.status === 400 && store.snapshotsOn && holdsSnapshots(store.drafts[draftId] ?? { snapshots: [], host: null })) {
      // The host refused the list: its own may have moved (an acceptance
      // released a snapshot). Read it, and save again from what it holds.
      void reconcileSnapshots(draftId);
      return;
    }
    if (result.status === 410 || (result.status === 404 && body.error === "DRAFT_NOT_FOUND")) {
      bumpHost(draftId);
      store.hostGone(draftId);
      for (const id of Object.keys(drafts.getState().drafts)) if (owed(drafts.getState().drafts[id]!)) schedule(id, 0);
      return;
    }
    if (result.status === 413) {
      store.saveFailed(draftId, { kind: "too_large", limit: Number(body.limit) || store.limits.maxDraftBytes, bound: String(body.bound ?? "draft") });
      return;
    }
    if (result.status === 507) {
      store.saveFailed(draftId, { kind: "full", limit: Number(body.limit) || store.limits.maxDrafts, bound: String(body.bound ?? "drafts") });
      return;
    }
    // No answer at all: the host may have stored it. That is settled before
    // an emptied draft is forgotten (`step`).
    store.saveFailed(draftId, { kind: "unsaved" }, result.status === 0);
    backoff(draftId);
  }

  async function sync(draftId: string): Promise<void> {
    if (!live() || busy.has(draftId)) return;
    const d = drafts.getState().drafts[draftId];
    if (!d || !owed(d)) return;
    busy.add(draftId);
    try {
      await step(d);
    } finally {
      busy.delete(draftId);
      drafts.getState().saving(draftId, null);
    }
    const after = drafts.getState().drafts[draftId];
    if (after && owed(after) && !timers.has(draftId)) schedule(draftId, 0);
    flushOrphans();
  }

  async function step(d: ComposerDraft): Promise<void> {
    const store = drafts.getState();
    const deviceGeneration = deviceSeq.get(d.draftId) ?? 0;
    const current = () => !disposed && deviceGeneration === (deviceSeq.get(d.draftId) ?? 0);
    if (d.bind && d.host) {
      const result = await api.bind(d.draftId, d.bind);
      if (!current()) return;
      if (result.ok) { bumpHost(d.draftId); drafts.getState().bound(d.draftId, result.value.revision); return; }
      if (result.status === 409 && result.body.error === "DRAFT_NOT_ACCEPTED") { drafts.getState().bindFailed(d.draftId); return; }
      failed(d.draftId, result);
      return;
    }
    if (!hasContent(d) && !holdsSnapshots(d) && !d.host && d.uncertain) {
      // Emptied after a save that got no answer: ask what the host holds,
      // and delete what it stored, rather than let a refresh bring it back.
      const read = await api.get(d.draftId);
      if (!current()) return;
      // The lost save created revision 1. A later one is another device's
      // edit since: never deleted unseen, it is a conflict on the empty draft.
      if (read.ok && read.value.revision > 1) {
        drafts.setState((s) => (s.drafts[d.draftId] ? { drafts: { ...s.drafts, [d.draftId]: { ...s.drafts[d.draftId]!, uncertain: false, host: { revision: read.value.revision, edit: -1, sessionId: read.value.sessionId, attachmentIds: read.value.attachments.map((a) => a.attachmentId), ...(read.value.files ? { fileIds: read.value.files.map((f) => f.fileId) } : {}), updatedAt: read.value.updatedAt } } } } : s));
        drafts.getState().conflictWith(d.draftId, read.value, true);
        return;
      }
      if (read.ok) {
        const result = await api.remove(d.draftId, read.value.revision);
        if (!current()) return;
        if (!result.ok && result.status !== 404 && result.status !== 410) { failed(d.draftId, result); return; }
      } else if (read.status !== 404 && read.status !== 410) { failed(d.draftId, read); return; }
      bumpHost(d.draftId);
      drafts.getState().removed(d.draftId);
      return;
    }
    if (!hasContent(d) && !holdsSnapshots(d)) {
      if (!d.host) return;
      const result = await api.remove(d.draftId, d.host.revision);
      if (!current()) return;
      if (result.ok) { bumpHost(d.draftId); failures.delete(d.draftId); drafts.getState().removed(d.draftId); retryFull(); return; }
      if (result.status === 410 || result.status === 404) { bumpHost(d.draftId); drafts.getState().removed(d.draftId); return; }
      failed(d.draftId, result);
      return;
    }
    store.saving(d.draftId, Date.now());
    // Images first: a save lists only images the host already stores.
    const uploads = new Map(d.uploads);
    for (const attachment of d.attachments) {
      if (uploads.has(attachment)) continue;
      let keys = uploadKeys.get(attachment);
      if (!keys) { keys = new Map(); uploadKeys.set(attachment, keys); }
      let k = keys.get(d.draftId);
      if (!k) { k = key(); keys.set(d.draftId, k); }
      const result = await api.upload(d.draftId, k, { mime: attachment.attachment.mediaType, base64: attachment.attachment.data, name: attachment.name || null });
      if (!current()) return;
      if (!result.ok) { failed(d.draftId, result, d.edit); return; }
      uploads.set(attachment, result.value.attachmentId);
      drafts.getState().uploaded(d.draftId, attachment, result.value.attachmentId);
    }
    // Only originals minted for this id can be bound here (#3155); one
    // carried from another id waits to be chosen again, and is not listed.
    const fileIds = bindableFiles(d).map((f) => f.file.fileId);
    // The whole snapshot list on every save, once the draft has one (#3588).
    const list = store.snapshotsOn && holdsSnapshots(d) ? snapshotSaveList(d) : null;
    const body = {
      // A save never moves a draft: a bound one stays its host session's until a bind.
      sessionId: d.host ? d.host.sessionId : d.sessionId,
      text: d.text,
      attachmentIds: d.attachments.map((a) => uploads.get(a)!),
      // Listed whenever this revision or the last one binds any, so removing
      // the last original unbinds it; omitted for a host without them.
      ...(fileIds.length > 0 || (d.host?.fileIds?.length ?? 0) > 0 ? { fileIds } : {}),
      ...(list ? { snapshots: list.writes } : {}),
    };
    const ifMatch = d.host?.revision ?? 0;
    const fingerprint = JSON.stringify([ifMatch, body]);
    const previous = saveKeys.get(d.draftId);
    const idempotencyKey = previous?.body === fingerprint ? previous.key : key();
    saveKeys.set(d.draftId, { body: fingerprint, key: idempotencyKey });
    const result = await api.save(d.draftId, ifMatch, idempotencyKey, body);
    if (!current()) return;
    if (result.ok) {
      saveKeys.delete(d.draftId);
      failures.delete(d.draftId);
      bumpHost(d.draftId);
      drafts.getState().saved(d.draftId, {
        // A Send again swap is two saves: until the second, this is not the whole edit.
        revision: result.value.revision, edit: list && !list.complete ? -1 : d.edit, sessionId: body.sessionId,
        attachmentIds: body.attachmentIds, ...(body.fileIds ? { fileIds: body.fileIds } : {}),
        ...(list ? { snapshots: list.writes } : {}), updatedAt: result.value.updatedAt,
      }, uploads);
      if (list) advanceSnapshots(d.draftId);
      return;
    }
    if (result.status === 409 && result.body.error === "DRAFT_KEY_REUSED") { saveKeys.delete(d.draftId); backoff(d.draftId); return; }
    // An image the host no longer stores (swept, or dropped by another
    // revision): upload again rather than save a list it cannot attach.
    if (result.status === 400 && /attachment/i.test(String(result.body.message ?? ""))) {
      drafts.getState().forgetUploads(d.draftId);
      backoff(d.draftId);
      return;
    }
    failed(d.draftId, result, d.edit);
  }

  /**
   * The host refused a snapshot list. Read what it holds: a held or
   * dispatched snapshot it no longer lists was released by its acceptance,
   * the only way one leaves without being returned first.
   */
  async function reconcileSnapshots(draftId: string): Promise<void> {
    const read = await api.get(draftId);
    if (disposed) return;
    const store = drafts.getState();
    const d = store.drafts[draftId];
    if (!d) return;
    if (!read.ok) { if (read.status === 404 || read.status === 410) { bumpHost(draftId); store.hostGone(draftId); } else backoff(draftId); return; }
    const held = new Set((read.value.snapshots ?? []).map((x) => x.snapshotId));
    for (const s of draftSnapshots(d)) {
      const acked = d.host?.snapshots?.some((x) => x.snapshotId === s.snapshotId);
      if (acked && !held.has(s.snapshotId) && s.state !== "returned") {
        const send = store.sends[s.requestId];
        if (send) drafts.getState().accepted(s.requestId, d.sessionId ?? undefined);
        else drafts.getState().snapshotReleased(draftId, s.requestId);
      }
    }
    const now = drafts.getState().drafts[draftId];
    if (!now?.host) { backoff(draftId); return; }
    // Saved again over the host's revision, with the host's list as acknowledged.
    bumpHost(draftId);
    drafts.setState((st) => st.drafts[draftId] ? { drafts: { ...st.drafts, [draftId]: { ...st.drafts[draftId]!, host: { ...st.drafts[draftId]!.host!, revision: read.value.revision, edit: -1,
      snapshots: (read.value.snapshots ?? []).map(({ createdAt: _at, ...w }) => w) } } } } : st);
    backoff(draftId);
  }

  /** Whether a snapshot of this draft may send now: connected, and a new chat's only from its own view. */
  function canDispatch(d: ComposerDraft): boolean {
    if (root.stores.connection.getState().wsStatus !== "connected" || root.authLock.state.getState().phase !== "active") return false;
    // A conversation still being restored takes no message yet (#1328): it waits, never fails.
    if (d.sessionId !== null && restorationOf(chat.getState())?.sessionId === d.sessionId) return false;
    if (d.sessionId !== null) return true;
    const c = chat.getState();
    return c.activeSessionId === null && drafts.getState().fresh === d.draftId && c.pendingDraftId === null;
  }

  const hostState = (d: ComposerDraft, s: ComposerSnapshot) => d.host?.snapshots?.find((x) => x.snapshotId === s.snapshotId);

  /**
   * After an acknowledged save: a held snapshot whose files are all stored and
   * bound moves to dispatched, and a dispatched one this tab owes is sent,
   * once, from the revision that holds it (rev 5 §2).
   */
  function advanceSnapshots(draftId: string) {
    const d = drafts.getState().drafts[draftId];
    if (!d || !live() || !drafts.getState().snapshotsOn || !canDispatch(d)) return;
    for (const s of draftSnapshots(d)) {
      const stored = hostState(d, s);
      if (s.state === "held" && !s.paused && !(s.uploads?.length) && stored?.state === "held"
        && stored.fileIds.length === s.files.length && stored.fileIds.every((id, i) => id === s.files[i]!.fileId)) {
        drafts.getState().patchSnapshot(draftId, s.snapshotId, { state: "dispatched", dispatch: "due" });
        soon(draftId);
      }
    }
    const now = drafts.getState().drafts[draftId]!;
    for (const s of draftSnapshots(now)) {
      if (s.state === "dispatched" && s.dispatch === "due" && !s.retiring && hostState(now, s)?.state === "dispatched" && !drafts.getState().sends[s.requestId]) dispatch(now, s);
    }
  }

  /** The frame a snapshot sends when this tab has none from its Send (a restored one). */
  function frameFor(d: ComposerDraft, s: ComposerSnapshot): Extract<ClientMessage, { type: "chat_message" }> {
    return { type: "chat_message", text: s.text, ...(d.sessionId ? { sessionId: d.sessionId } : {}), requestId: s.requestId, client: detectClientEnvironment(), source: "typed" };
  }

  /** Send a dispatched snapshot's message: its text, its files, and a revision that holds it. */
  function dispatch(d: ComposerDraft, s: ComposerSnapshot) {
    const draftRef = { draftId: d.draftId, revision: d.host!.revision };
    const { draftRef: _r, attachmentRefs: _a, draftId: _c, ...template } = s.message ?? frameFor(d, s);
    const fileIds = s.files.map((f) => f.fileId);
    const message: Extract<ClientMessage, { type: "chat_message" }> = {
      ...template, type: "chat_message", text: s.text, requestId: s.requestId, draftRef,
      ...(fileIds.length ? { attachmentRefs: fileIds.map((fileId) => ({ kind: "attachment" as const, fileId })) } : {}),
    };
    const attachmentFiles = s.files.flatMap((f) => f.file ? [{ file: f.file, lineage: d.draftId }] : []);
    drafts.getState().patchSnapshot(d.draftId, s.snapshotId, { dispatch: "sent" }, true);
    drafts.getState().beginSnapshotSend({
      requestId: s.requestId, draftId: d.draftId, sessionId: d.sessionId, text: s.text, attachments: [],
      ...(attachmentFiles.length ? { attachmentFiles } : {}), snapshotId: s.snapshotId, draftRef, message,
    });
    // The transcript draws it as the composer always has: the bubble became the message.
    const c = chat.getState();
    const key = d.sessionId;
    const buffer = key === null ? c.draft : c.buffers[key];
    const streaming = buffer?.isStreaming ?? false;
    const source = message.source ?? "typed";
    if (streaming && key !== null && root.stores.connection.getState().followUpQueue) {
      root.stores.followUp.getState().addLocal(key, { requestId: s.requestId, text: s.text, source, ...(message.thinkingLevel !== undefined ? { thinkingLevel: message.thinkingLevel } : {}), queuedAt: Date.now() });
    } else {
      c.addUserMessage(key, s.text, source, undefined, { requestId: s.requestId, ...(message.thinkingLevel !== undefined ? { thinkingLevel: message.thinkingLevel } : {}) },
        undefined, attachmentFiles.length ? attachmentFiles.map((f) => f.file) : undefined);
    }
    if (!streaming) c.startAssistantMessage(key, undefined, s.requestId);
    const correlation = key ? undefined : c.startDraftTurn();
    const sent = options.send({ ...message, ...(correlation ? { draftId: correlation } : {}) });
    if (!sent) {
      const send = drafts.getState().sends[s.requestId];
      if (send) withdraw(send);
      drafts.getState().sendFailed(s.requestId);
    }
  }

  /** Orphans whose delete got no answer, waiting for their next try. */
  const orphanRetries = new Map<string, { orphan: { draftId: string; revision: number }; tries: number; timer: ReturnType<typeof setTimeout> }>();

  /** Orphans whose delete is out: a list taken meanwhile still shows them, and is not believed. */
  const deleting = new Set<string>();

  function removeOrphan(orphan: { draftId: string; revision: number }, tries = 0) {
    // A read of it begun before this delete is stale whatever the delete's answer.
    bumpHost(orphan.draftId);
    deleting.add(orphan.draftId);
    void api.remove(orphan.draftId, orphan.revision).then((result) => {
      bumpHost(orphan.draftId);
      if (disposed) return;
      orphanRetries.delete(orphan.draftId);
      if (result.ok || !transient(result.status)) deleting.delete(orphan.draftId);
      // No answer: try again later, backing off as saves do. A conflict means
      // another device changed it since: it is theirs, and the next list shows it.
      if (!result.ok && transient(result.status)) {
        const timer = setTimeout(() => removeOrphan(orphan, tries + 1), RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]);
        orphanRetries.set(orphan.draftId, { orphan, tries: tries + 1, timer });
      } else if (result.ok) retryFull();
    });
  }

  function flushOrphans() {
    if (!live()) return;
    for (const orphan of drafts.getState().takeOrphans()) {
      if (!orphanRetries.has(orphan.draftId)) removeOrphan(orphan);
    }
  }

  let refreshRetry: { timer: ReturnType<typeof setTimeout>; tries: number } | null = null;
  /** A list or a read that got no answer, or a transient refusal: ask again, backing off. */
  function retryRefresh() {
    if (disposed) return;
    const tries = refreshRetry?.tries ?? 0;
    if (refreshRetry) clearTimeout(refreshRetry.timer);
    refreshRetry = { tries: tries + 1, timer: setTimeout(() => { void refresh(); }, RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]) };
  }
  const transient = (status: number) => status === 0 || status >= 500 || status === 401 || status === 403;

  /** The host's drafts, applied: newer versions restored or raised as conflicts. */
  async function refresh(): Promise<void> {
    if (!live() || listing) return;
    listing = true;
    try {
      // What this device kept goes back first (#1014), so the host's
      // versions meet it as they would meet the page that wrote it.
      await root.localWork?.restoring();
    } catch { /* restoring never rejects; nothing to wait for */ }
    if (disposed) { listing = false; return; }
    const before = new Map(hostSeq);
    try {
      const result = await api.list();
      if (disposed) return;
      if (!result.ok) { if (transient(result.status)) retryRefresh(); return; }
      let readFailed = false;
      const listed = new Map(result.value.drafts.map((s) => [s.draftId, s]));
      let freed = false;
      // Gone from the host while nothing here is newer: deleted or sent
      // elsewhere. First, so a draft that replaced it for the same session
      // is restored as itself rather than as a conflict on a draft that is gone.
      for (const d of Object.values(drafts.getState().drafts)) {
        if (!d.host || listed.has(d.draftId) || busy.has(d.draftId)) continue;
        if ((hostSeq.get(d.draftId) ?? 0) !== (before.get(d.draftId) ?? 0)) continue;
        drafts.getState().hostGone(d.draftId);
        freed = true;
      }
      for (const summary of result.value.drafts) {
        const local = drafts.getState().drafts[summary.draftId];
        if (local?.host && local.host.revision >= summary.revision) continue;
        if (local?.conflict?.sameId && local.conflict.other.revision >= summary.revision) continue;
        if (busy.has(summary.draftId) || deleting.has(summary.draftId)) continue;
        const seq = hostSeq.get(summary.draftId) ?? 0;
        const full = await api.get(summary.draftId);
        if (disposed) return;
        // Something here changed what the host holds while the read was out
        // (a save, a delete, a send that consumed it): the read is stale.
        if ((hostSeq.get(summary.draftId) ?? 0) !== seq || (before.get(summary.draftId) ?? 0) !== seq || busy.has(summary.draftId) || deleting.has(summary.draftId)) continue;
        if (full.ok) drafts.getState().restore(full.value);
        else if (transient(full.status)) readFailed = true;
      }
      // A draft deleted or sent elsewhere freed a place on the host.
      if (freed) retryFull();
      if (readFailed) retryRefresh();
      else if (refreshRetry) { clearTimeout(refreshRetry.timer); refreshRetry = null; }
    } finally {
      listing = false;
    }
    for (const d of Object.values(drafts.getState().drafts)) if (owed(d)) schedule(d.draftId, 0);
  }

  /** Take the optimistic rows of a send out of the transcript: the review block stands for it. */
  function withdraw(send: DraftSend) {
    chat.getState().withdrawSend(send.sessionId, send.requestId);
    root.stores.followUp.getState().dropLocal(send.requestId);
  }

  /** The host accepted a send: its staged tracks are the message's, and a new chat's become its session's. */
  function acceptedTracks(send: DraftSend, sessionId: string | undefined) {
    if (send.tracks) removeTracks(root, send.tracks.key, send.tracks.ids);
    if (send.sessionId === null && sessionId) {
      const origin = drafts.getState().originOf(drafts.getState().sendDraftId(send.requestId) ?? send.draftId);
      moveTracks(root, trackKey(null, origin), trackKey(sessionId, origin));
    }
  }

  /** A save was refused for capacity: another draft's deletion may have made room. */
  function retryFull() {
    for (const d of Object.values(drafts.getState().drafts)) {
      if (d.failure?.kind !== "full") continue;
      drafts.getState().saveFailed(d.draftId, { kind: "unsaved" });
      schedule(d.draftId, 0);
    }
  }

  /**
   * A new chat's held first message acts only in its own new chat: if the
   * view shows another (or any session), it opens that one first, as New
   * chat does, so the other's transcript and announcement stay its own.
   */
  function openOwnNewChat(send: DraftSend) {
    const c = chat.getState();
    const draftId = drafts.getState().sendDraftId(send.requestId) ?? send.draftId;
    if (c.activeSessionId !== null || drafts.getState().fresh !== draftId || c.pendingDraftId !== null) {
      c.clearMessages();
      drafts.setState({ fresh: draftId });
    }
  }

  /** A send's rows in its transcript, as the composer drew them when it was sent. */
  function restoreRows(send: DraftSend, key: string | null) {
    const c = chat.getState();
    const buffer = key === null ? c.draft : c.buffers[key];
    if (buffer?.messages.some((m) => m.role === "user" && m.requestId === send.requestId)) return;
    c.addUserMessage(key, send.text, send.message.source,
      send.attachments.length ? send.attachments.map((a) => ({ previewUrl: a.previewUrl, mediaType: a.attachment.mediaType })) : undefined,
      { requestId: send.requestId, ...(send.message.thinkingLevel !== undefined ? { thinkingLevel: send.message.thinkingLevel } : {}) },
      send.files?.length ? send.files : undefined,
      send.attachmentFiles?.length ? send.attachmentFiles.map((f) => f.file) : undefined);
    if (!(buffer?.isStreaming ?? false)) c.startAssistantMessage(key, undefined, send.requestId);
  }

  // Changes to a draft's content schedule its save.
  const unsubscribeDrafts = drafts.subscribe((state, prev) => {
    for (const [id, d] of Object.entries(state.drafts)) if (d.deviceEpoch !== undefined && d.deviceEpoch !== prev.drafts[id]?.deviceEpoch) {
      deviceSeq.set(id, (deviceSeq.get(id) ?? 0) + 1);
      bumpHost(id);
    }
    for (const [id, d] of Object.entries(state.drafts)) if (!prev.drafts[id] && d.deviceConflict) {
      // The other identity can be a predecessor retired by a send while
      // the native fork was pending. Its outstanding calls still need a fence.
      const sources = new Set([...Object.keys(prev.drafts), d.deviceConflict.otherId]);
      for (const source of sources) if (state.resolveId(source) === id || source === d.deviceConflict.otherId) {
        deviceSeq.set(source, (deviceSeq.get(source) ?? 0) + 1);
        bumpHost(source);
      }
    }
    if (!live()) return;
    for (const [id, d] of Object.entries(state.drafts)) {
      const before = prev.drafts[id];
      if (before && before.edit === d.edit && before.conflict === d.conflict && before.bind === d.bind && before.host === d.host) continue;
      // A snapshot change is a send's step: it goes at once, not after a pause in typing.
      const snapshotStep = before?.snapshots !== d.snapshots && d.snapshots !== undefined;
      if (owed(d)) {
        if (snapshotStep) soon(id);
        else schedule(id, d.edit !== before?.edit ? SAVE_DELAY_MS : 0);
      }
    }
    // A send that settled may release a draft that only it was holding, or
    // one whose saves waited for a snapshot's answer.
    if (state.sends !== prev.sends) for (const d of Object.values(state.drafts)) if ((!hasContent(d) || holdsSnapshots(d)) && owed(d)) schedule(d.draftId, 0);
    if (state.snapshotsOn) adoptRestored(state);
    if (state.orphans.length > 0 && state.orphans !== prev.orphans) flushOrphans();
  });

  /**
   * A dispatched snapshot this page did not send (a reload, another tab's):
   * no answer will come for it here, so it reads as unconfirmed, with Check
   * and Send again, and is never sent again by itself (rev 5 §4).
   */
  function adoptRestored(state: ReturnType<typeof drafts.getState>) {
    for (const d of Object.values(state.drafts)) {
      for (const s of draftSnapshots(d)) {
        if (s.state !== "dispatched" || s.dispatch || s.retiring || state.sends[s.requestId] || !hostState(d, s)) continue;
        drafts.getState().beginSnapshotSend({
          requestId: s.requestId, draftId: d.draftId, sessionId: d.sessionId, text: s.text, attachments: [],
          snapshotId: s.snapshotId, draftRef: null, message: s.message ?? frameFor(d, s), unconfirmedAs: "disconnected",
        });
      }
    }
  }

  /** Every send still waiting is held for review: nothing will answer for it now. */
  function holdPending(reason: "disconnected" | "uncorrelated") {
    for (const requestId of drafts.getState().unconfirmed(reason)) {
      const send = drafts.getState().sends[requestId];
      if (send) withdraw(send);
    }
  }

  // Silence from the host about a send: the socket closed.
  const unsubscribeConnection = root.stores.connection.subscribe((state, prev) => {
    if (prev.wsStatus === "connected" && state.wsStatus !== "connected") holdPending("disconnected");
    if (prev.wsStatus !== "connected" && state.wsStatus === "connected") advanceAll();
  });
  // A new chat's snapshot sends only from its own view: it waits until shown.
  const unsubscribeView = chat.subscribe((state, prev) => {
    if (state.activeSessionId !== prev.activeSessionId || state.pendingDraftId !== prev.pendingDraftId || restorationOf(state) !== restorationOf(prev)) advanceAll();
  });
  function advanceAll() { if (drafts.getState().snapshotsOn) for (const id of Object.keys(drafts.getState().drafts)) advanceSnapshots(id); }

  /**
   * The queue-full notice (#3155) clears when this tab frees a slot, and
   * otherwise from a host read: the chat's drafts are listed, and each one of
   * that chat is read for its snapshots. Reads only, never a save; it runs
   * only while the notice shows and the tab is visible, every
   * FULL_RECHECK_MS, and at once on focus, `online` and hello.
   */
  let fullTimer: ReturnType<typeof setTimeout> | null = null;
  let fullChecking = false;
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  function scheduleFullCheck() {
    if (fullTimer) { clearTimeout(fullTimer); fullTimer = null; }
    if (disposed || !drafts.getState().outgoingFull || !visible()) return;
    fullTimer = setTimeout(() => { fullTimer = null; void recheckFull(); }, FULL_RECHECK_MS);
  }
  async function recheckFull(): Promise<void> {
    const full = drafts.getState().outgoingFull;
    if (disposed || !full || fullChecking || !visible() || !live()) { scheduleFullCheck(); return; }
    fullChecking = true;
    try {
      const listed = await api.list();
      if (disposed || drafts.getState().outgoingFull !== full) return;
      if (!listed.ok) return;
      const ids = listed.value.drafts
        .filter((x) => x.draftId === full.draftId || (full.sessionId !== null && x.sessionId === full.sessionId))
        .map((x) => x.draftId);
      let count = 0;
      for (const id of ids) {
        const read = await api.get(id);
        if (disposed || drafts.getState().outgoingFull !== full) return;
        // A draft gone since the list holds nothing; any other failure proves nothing.
        if (!read.ok) { if (read.status === 404 || read.status === 410) continue; return; }
        count += read.value.snapshots?.length ?? 0;
      }
      if (count < full.limit) drafts.getState().clearOutgoingFull();
    } finally {
      fullChecking = false;
      scheduleFullCheck();
    }
  }
  const unsubscribeFull = drafts.subscribe((state, prev) => { if (state.outgoingFull !== prev.outgoingFull) scheduleFullCheck(); });
  const onFocus = () => { if (drafts.getState().outgoingFull) void recheckFull(); };
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);

  const onVisible = () => {
    if (document.visibilityState === "visible") { void refresh(); if (drafts.getState().outgoingFull) void recheckFull(); }
    else scheduleFullCheck();
  };
  const onOnline = () => {
    void refresh();
    if (drafts.getState().outgoingFull) void recheckFull();
    for (const d of Object.values(drafts.getState().drafts)) if (owed(d)) schedule(d.draftId, 0);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);

  return {
    /** The host's hello: whether it keeps drafts, and its limits. */
    hello(msg: Extract<ServerMessage, { type: "server_hello" }>): void {
      if (disposed) return;
      const supported = msg.capabilities?.sessionDrafts === true;
      // Composer originals need durable drafts to bind them (#3155, design §9).
      const files = supported && msg.capabilities?.[COMPOSER_FILES_CAPABILITY] === true ? msg.attachmentLimits ?? null : null;
      const limits = supported ? (msg.sessionDraftLimits as SessionDraftLimits | undefined) : undefined;
      // Durable snapshots need a host that says it keeps them, and request receipts to settle them (#3155).
      const snapshots = files !== null && typeof limits?.maxOutgoingSnapshots === "number" && msg.capabilities?.chatRequestAck === true;
      drafts.getState().setSupport(supported, limits, files, snapshots);
      if (!supported) return;
      failures.clear();
      // A new connection is new evidence: what was full may have room now.
      retryFull();
      void refresh();
      for (const d of Object.values(drafts.getState().drafts)) if (owed(d)) schedule(d.draftId, 0);
      if (drafts.getState().outgoingFull) void recheckFull();
    },

    /**
     * An `error` frame. One that names no request and is a frame-level
     * refusal may have been any send's: every waiting send is held. One that
     * names its request settles only that one, through `receipt`.
     */
    error(msg: Extract<ServerMessage, { type: "error" }>): void {
      if (!msg.requestId && UNCORRELATED.includes(msg.code)) holdPending("uncorrelated");
    },

    /** A queue report names requests the host holds: each was accepted. They stay pending pills, not rows. */
    queued(msg: Extract<ServerMessage, { type: "session_queue" }>): void {
      const ids = [...msg.followUps.map((f) => f.requestId), msg.started?.requestId].filter((id): id is string => Boolean(id));
      for (const requestId of ids) {
        const send = drafts.getState().sends[requestId];
        if (!send || send.state === "accepted" || send.state === "refused") continue;
        // Held, its pending entry withdrawn: back as this page's own, so the
        // report draws the full text and images it kept, not the host's summary.
        if (send.state === "unconfirmed" && !root.stores.followUp.getState().local[msg.sessionId]?.some((l) => l.requestId === requestId)) {
          root.stores.followUp.getState().addLocal(msg.sessionId, {
            requestId, text: send.text, source: send.message.source ?? "typed",
            ...(send.attachments.length ? { attachments: send.attachments.map((a) => ({ previewUrl: a.previewUrl, mediaType: a.attachment.mediaType })) } : {}),
            ...(send.files?.length ? { files: send.files } : {}),
            ...(send.message.thinkingLevel !== undefined ? { thinkingLevel: send.message.thinkingLevel } : {}),
            queuedAt: send.sentAt,
          });
        }
        bumpHost(send.draftId);
        drafts.getState().accepted(requestId, msg.sessionId);
        acceptedTracks(send, msg.sessionId);
      }
    },

    /** A host frame that names a chat request: it accepted or refused exactly that one. */
    receipt(requestId: string, state: "accepted" | "refused", sessionId: string | undefined): boolean {
      const send = drafts.getState().sends[requestId];
      if (!send) return false;
      if (state === "accepted") {
        // What the host holds for that draft changed: a read begun before this is stale.
        bumpHost(send.draftId);
        drafts.getState().accepted(requestId, sessionId);
        acceptedTracks(send, sessionId);
        // Consuming a saved draft frees a place on the host.
        if (send.draftRef) retryFull();
        // Accepted after all: its rows come back before the turn's frames do.
        if (send.state === "unconfirmed") restoreRows(send, sessionId ?? send.sessionId);
      } else {
        drafts.getState().refused(requestId);
        // Its bubble says it was not sent: the transcript does not say it twice.
        if (send.snapshotId) withdraw(send);
      }
      return true;
    },

    /** Send again: the same snapshot, under a new request id. */
    resend(requestId: string): boolean {
      const store = drafts.getState();
      const nextRequestId = crypto.randomUUID();
      const held = store.sends[requestId];
      if (!held || held.state !== "unconfirmed") return false;
      if (held.sessionId === null) openOwnNewChat(held);
      const next = drafts.getState().resend(requestId, nextRequestId);
      if (!next) return false;
      // The session's tracker waits on the request now sent, not the one replaced.
      root.stores.trackers.setState((s) => {
        const rekey = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === requestId ? nextRequestId : v]));
        return { unconfirmed: rekey(s.unconfirmed), createdFor: rekey(s.createdFor) };
      });
      restoreRows(next, next.sessionId);
      const correlation = next.sessionId ? undefined : chat.getState().startDraftTurn();
      const message = { ...next.message, ...(correlation ? { draftId: correlation } : {}) };
      const sent = options.send(message);
      // Nothing left: like a closed socket, every send still waiting is held.
      if (!sent) holdPending("disconnected");
      return sent;
    },

    /** Edit: the held send's text and images go back into its own draft, in its own view. */
    edit(requestId: string): void {
      const held = drafts.getState().sends[requestId];
      if (!held || held.state !== "unconfirmed") return;
      if (held.sessionId === null) openOwnNewChat(held);
      drafts.getState().editSend(requestId);
    },

    /**
     * Check again: the session's recovery envelope says whether the host
     * accepted this request. A first message has no session to ask about.
     */
    async check(requestId: string): Promise<void> {
      const send = drafts.getState().sends[requestId];
      if (!send || send.state !== "unconfirmed") return;
      const sessionId = send.sessionId;
      if (!sessionId || root.stores.trackers.getState().recoverySupported !== true) {
        drafts.getState().setChecked(requestId, "cant_check", sessionId ? "host too old" : "no session yet");
        return;
      }
      drafts.getState().setChecked(requestId, "checking");
      const result = await root.api.sessionRecovery(sessionId, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (disposed) return;
      const current = drafts.getState().sends[requestId];
      if (!current || current.state !== "unconfirmed") return;
      if (!result.ok) {
        const reason = result.reason === "host_too_old" ? "host too old" : result.reason === "session_not_found" ? "session not found" : result.reason === "unauthorized" ? "not authorized" : "host unreachable";
        drafts.getState().setChecked(requestId, "cant_check", reason);
        return;
      }
      if (result.recovery.latest.requestId === requestId) {
        bumpHost(current.draftId);
        drafts.getState().accepted(requestId, sessionId);
        acceptedTracks(current, sessionId);
        root.stores.trackers.getState().accepted([requestId]);
        // It is a normal turn: the transcript reads it from the host.
        options.send({ type: "session_resume", sessionId });
        return;
      }
      // No acceptance on record at all: this request was not accepted. The
      // snapshot returns, and Edit or Delete… are offered (rev 5 §2).
      if (current.snapshotId && result.recovery.revision === 0) {
        drafts.getState().refused(requestId);
        const draftId = drafts.getState().sendDraftId(requestId) ?? current.draftId;
        drafts.getState().patchSnapshot(draftId, current.snapshotId, { why: { kind: "failed", reason: "The brain has no record of it." } }, true);
        return;
      }
      // Another request is the latest: this one may have been accepted
      // before it, or never. That proves neither (D52 §6 names only the latest).
      drafts.getState().setChecked(requestId, "cant_check", "the host's latest is another message");
    },

    /**
     * Send again for a snapshot's send: a new request replaces it. The old
     * snapshot is returned and then left out as its successor is created,
     * so the swap never needs a free slot; only then is the new one sent.
     */
    resendSnapshot(requestId: string): boolean {
      const store = drafts.getState();
      const send = store.sends[requestId];
      if (!send?.snapshotId || send.state !== "unconfirmed") return false;
      const draftId = store.sendDraftId(requestId) ?? send.draftId;
      const nextRequestId = crypto.randomUUID();
      const { draftRef: _r, attachmentRefs: _a, ...template } = send.message;
      store.resendSnapshot(draftId, send.snapshotId, { snapshotId: crypto.randomUUID(), requestId: nextRequestId, message: { ...template, requestId: nextRequestId } });
      root.stores.trackers.setState((s) => {
        const rekey = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === requestId ? nextRequestId : v]));
        return { unconfirmed: rekey(s.unconfirmed), createdFor: rekey(s.createdFor) };
      });
      // The old request is abandoned here: an answer for it now finds nothing.
      drafts.setState((st) => { const sends = { ...st.sends }; delete sends[requestId]; return { sends }; });
      schedule(draftId, 0);
      return true;
    },

    /** Send on a paused snapshot (a hold restored after reload): only now, and only by this tap. */
    sendPaused(draftId: string, snapshotId: string): void {
      const d = drafts.getState().drafts[draftId];
      const s = d && draftSnapshots(d).find((x) => x.snapshotId === snapshotId);
      if (!d || !s || s.state !== "held" || !s.paused) return;
      drafts.getState().patchSnapshot(draftId, snapshotId, { paused: false, state: "dispatched", dispatch: "due", message: s.message ?? frameFor(d, s) });
      schedule(draftId, 0);
    },

    dispose(): void {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const retry of orphanRetries.values()) clearTimeout(retry.timer);
      if (refreshRetry) clearTimeout(refreshRetry.timer);
      orphanRetries.clear();
      unsubscribeDrafts();
      unsubscribeConnection();
      unsubscribeView();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
      if (fullTimer) clearTimeout(fullTimer);
      unsubscribeFull();
    },
  };
}

export type DraftClient = ReturnType<typeof createDraftClient>;
