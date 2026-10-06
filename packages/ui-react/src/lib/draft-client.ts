import type { ClientMessage, Draft, ServerMessage, SessionDraftLimits } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { createDraftApi, type DraftApi, type DraftCallResult } from "./draft-api.js";
import { hasContent, type ComposerDraft, type DraftSend } from "../stores/draft-state.js";
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
/** Backoff for a save that got no answer or a transient refusal. */
const RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/** Errors the host sends for a frame it could not tie to a request, when they name none. */
const UNCORRELATED = ["RATE_LIMITED", "PARSE_ERROR", "INTERNAL_ERROR"];

export interface DraftClientOptions {
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
  let listing = false;

  const key = () => crypto.randomUUID();
  const live = () => !disposed && drafts.getState().supported === true;

  function schedule(draftId: string, delay = SAVE_DELAY_MS) {
    if (!live()) return;
    clearTimeout(timers.get(draftId));
    timers.set(draftId, setTimeout(() => { timers.delete(draftId); void sync(draftId); }, delay));
  }

  function backoff(draftId: string) {
    const n = failures.get(draftId) ?? 0;
    failures.set(draftId, n + 1);
    schedule(draftId, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
  }

  /** The draft needs a call: different from what the host acknowledged, or owed a bind or a delete. */
  function owed(d: ComposerDraft): boolean {
    if (d.conflict) return false;
    if (d.failure && d.failure.kind !== "unsaved") return false;
    if (d.bind) return true;
    if (!hasContent(d)) return d.host !== null && !held(d.draftId);
    return d.host === null || d.host.edit !== d.edit;
  }

  function held(draftId: string): boolean {
    return Object.values(drafts.getState().sends).some((s) => s.draftId === draftId && (s.state === "pending" || s.state === "unconfirmed"));
  }

  function bumpHost(draftId: string) { hostSeq.set(draftId, (hostSeq.get(draftId) ?? 0) + 1); }

  /** A failed call's meaning for the draft. True when it was handled and should not be retried. */
  function failed(draftId: string, result: Exclude<DraftCallResult<unknown>, { ok: true }>): void {
    const body = result.body;
    const store = drafts.getState();
    if (result.status === 409 && body.error === "DRAFT_CONFLICT" && body.current) {
      store.conflictWith(draftId, body.current as Draft, true);
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
    store.saveFailed(draftId, { kind: "unsaved" });
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
    if (d.bind && d.host) {
      const result = await api.bind(d.draftId, d.bind);
      if (result.ok) { bumpHost(d.draftId); drafts.getState().bound(d.draftId, result.value.revision); return; }
      if (result.status === 409 && result.body.error === "DRAFT_NOT_ACCEPTED") { drafts.getState().bindFailed(d.draftId); return; }
      failed(d.draftId, result);
      return;
    }
    if (!hasContent(d)) {
      if (!d.host) return;
      const result = await api.remove(d.draftId, d.host.revision);
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
      if (disposed) return;
      if (!result.ok) { failed(d.draftId, result); return; }
      uploads.set(attachment, result.value.attachmentId);
      drafts.getState().uploaded(d.draftId, attachment, result.value.attachmentId);
    }
    const body = {
      // A save never moves a draft: a bound one stays its host session's until a bind.
      sessionId: d.host ? d.host.sessionId : d.sessionId,
      text: d.text,
      attachmentIds: d.attachments.map((a) => uploads.get(a)!),
    };
    const ifMatch = d.host?.revision ?? 0;
    const fingerprint = JSON.stringify([ifMatch, body]);
    const previous = saveKeys.get(d.draftId);
    const idempotencyKey = previous?.body === fingerprint ? previous.key : key();
    saveKeys.set(d.draftId, { body: fingerprint, key: idempotencyKey });
    const result = await api.save(d.draftId, ifMatch, idempotencyKey, body);
    if (disposed) return;
    if (result.ok) {
      saveKeys.delete(d.draftId);
      failures.delete(d.draftId);
      bumpHost(d.draftId);
      drafts.getState().saved(d.draftId, {
        revision: result.value.revision, edit: d.edit, sessionId: body.sessionId,
        attachmentIds: body.attachmentIds, updatedAt: result.value.updatedAt,
      }, uploads);
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
    failed(d.draftId, result);
  }

  /** Orphans whose delete got no answer, waiting for their next try. */
  const orphanRetries = new Map<string, { orphan: { draftId: string; revision: number }; tries: number; timer: ReturnType<typeof setTimeout> }>();

  function removeOrphan(orphan: { draftId: string; revision: number }, tries = 0) {
    void api.remove(orphan.draftId, orphan.revision).then((result) => {
      if (disposed) return;
      orphanRetries.delete(orphan.draftId);
      // No answer: try again later, backing off as saves do. A conflict means
      // another device changed it since: it is theirs, and the next list shows it.
      if (!result.ok && result.status === 0) {
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

  /** The host's drafts, applied: newer versions restored or raised as conflicts. */
  async function refresh(): Promise<void> {
    if (!live() || listing) return;
    listing = true;
    const before = new Map(hostSeq);
    try {
      const result = await api.list();
      if (!result.ok || disposed) return;
      const listed = new Map(result.value.drafts.map((s) => [s.draftId, s]));
      for (const summary of result.value.drafts) {
        const local = drafts.getState().drafts[summary.draftId];
        if (local?.host && local.host.revision >= summary.revision) continue;
        if (local?.conflict?.sameId && local.conflict.other.revision >= summary.revision) continue;
        if (busy.has(summary.draftId)) continue;
        const full = await api.get(summary.draftId);
        if (disposed) return;
        if (full.ok) drafts.getState().restore(full.value);
      }
      // Gone from the host while nothing here is newer: deleted or sent elsewhere.
      for (const d of Object.values(drafts.getState().drafts)) {
        if (!d.host || listed.has(d.draftId) || busy.has(d.draftId)) continue;
        if ((hostSeq.get(d.draftId) ?? 0) !== (before.get(d.draftId) ?? 0)) continue;
        drafts.getState().hostGone(d.draftId);
      }
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
    if (send.sessionId === null && sessionId) moveTracks(root, trackKey(null, send.draftId), trackKey(sessionId, send.draftId));
  }

  /** A save was refused for capacity: another draft's deletion may have made room. */
  function retryFull() {
    for (const d of Object.values(drafts.getState().drafts)) {
      if (d.failure?.kind !== "full") continue;
      drafts.getState().saveFailed(d.draftId, { kind: "unsaved" });
      schedule(d.draftId, 0);
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
      send.files?.length ? send.files : undefined);
    if (!(buffer?.isStreaming ?? false)) c.startAssistantMessage(key, undefined, send.requestId);
  }

  // Changes to a draft's content schedule its save.
  const unsubscribeDrafts = drafts.subscribe((state, prev) => {
    if (!live()) return;
    for (const [id, d] of Object.entries(state.drafts)) {
      const before = prev.drafts[id];
      if (before && before.edit === d.edit && before.conflict === d.conflict && before.bind === d.bind && before.host === d.host) continue;
      if (owed(d)) schedule(id, d.edit !== before?.edit ? SAVE_DELAY_MS : 0);
    }
    // A send that settled may release a draft that only it was holding.
    if (state.sends !== prev.sends) for (const d of Object.values(state.drafts)) if (!hasContent(d) && owed(d)) schedule(d.draftId, 0);
    if (state.orphans.length > 0 && state.orphans !== prev.orphans) flushOrphans();
  });

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
  });

  const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
  const onOnline = () => {
    void refresh();
    for (const d of Object.values(drafts.getState().drafts)) if (owed(d)) schedule(d.draftId, 0);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);

  return {
    /** The host's hello: whether it keeps drafts, and its limits. */
    hello(msg: Extract<ServerMessage, { type: "server_hello" }>): void {
      if (disposed) return;
      const supported = msg.capabilities?.sessionDrafts === true;
      drafts.getState().setSupport(supported, supported ? (msg.sessionDraftLimits as SessionDraftLimits | undefined) : undefined);
      if (!supported) return;
      failures.clear();
      // A new connection is new evidence: what was full may have room now.
      retryFull();
      void refresh();
      for (const d of Object.values(drafts.getState().drafts)) if (owed(d)) schedule(d.draftId, 0);
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
        drafts.getState().accepted(requestId, msg.sessionId);
        acceptedTracks(send, msg.sessionId);
      }
    },

    /** A host frame that names a chat request: it accepted or refused exactly that one. */
    receipt(requestId: string, state: "accepted" | "refused", sessionId: string | undefined): boolean {
      const send = drafts.getState().sends[requestId];
      if (!send) return false;
      if (state === "accepted") {
        drafts.getState().accepted(requestId, sessionId);
        acceptedTracks(send, sessionId);
        // Accepted after all: its rows come back before the turn's frames do.
        if (send.state === "unconfirmed") restoreRows(send, sessionId ?? send.sessionId);
      } else drafts.getState().refused(requestId);
      return true;
    },

    /** Send again: the same snapshot, under a new request id. */
    resend(requestId: string): boolean {
      const store = drafts.getState();
      const nextRequestId = crypto.randomUUID();
      const next = store.resend(requestId, nextRequestId);
      if (!next) return false;
      restoreRows(next, next.sessionId);
      const correlation = next.sessionId ? undefined : chat.getState().startDraftTurn();
      const message = { ...next.message, ...(correlation ? { draftId: correlation } : {}) };
      const sent = options.send(message);
      if (!sent) {
        drafts.getState().unconfirmed("disconnected");
        withdraw(drafts.getState().sends[nextRequestId] ?? next);
      }
      return sent;
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
        drafts.getState().accepted(requestId, sessionId);
        acceptedTracks(current, sessionId);
        root.stores.trackers.getState().accepted([requestId]);
        // It is a normal turn: the transcript reads it from the host.
        options.send({ type: "session_resume", sessionId });
        return;
      }
      // Another request is the latest: this one may have been accepted
      // before it, or never. That proves neither (D52 §6 names only the latest).
      drafts.getState().setChecked(requestId, "cant_check", "the host's latest is another message");
    },

    dispose(): void {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const retry of orphanRetries.values()) clearTimeout(retry.timer);
      orphanRetries.clear();
      unsubscribeDrafts();
      unsubscribeConnection();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    },
  };
}

export type DraftClient = ReturnType<typeof createDraftClient>;
