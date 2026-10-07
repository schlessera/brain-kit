import { createStore } from "zustand/vanilla";
import {
  SESSION_DRAFT_LIMITS,
  type ClientMessage,
  type Draft,
  type DraftRef,
  type SessionDraftLimits,
  type SharedFileMeta,
} from "@schlessera/brain-ui-sdk/protocol";
import type { PendingAttachment } from "../lib/image-attachments.js";
import { attachmentFromDraft, mintDraftId } from "../lib/drafts.js";

/**
 * Every composer's draft, owned by the root (D52 §5, #951).
 *
 * A composer belongs to `{draftId, sessionId | null, revision}`. `draftId`
 * is a client UUID, so there is no shared null-session bucket: the new-chat
 * view shows `fresh`, and New chat gives it a new identity, so the old one
 * stays where it was. A session shows the draft whose `sessionId` is its
 * own. View unmounts, remounts and transcript-buffer eviction never touch
 * this store, and nothing here is ever sent: a send takes an immutable
 * snapshot (`sends`), and only the host's answer for that request settles
 * it.
 *
 * Content is kept here whatever the host says. Saving is the draft client's
 * (`lib/draft-client.ts`): `host` is what the host acknowledged, never what
 * was asked of it, so a draft reads as saved only when its edit generation
 * is the acknowledged one.
 */

export type DraftSaveFailure =
  /** Dirty and unreachable, or a transient refusal: retried with backoff. */
  | { kind: "unsaved" }
  /** 413: `limit` bytes (or images), named by `bound`. */
  | { kind: "too_large"; limit: number; bound: string }
  /** 507: the host keeps `limit` drafts, or bytes, already. */
  | { kind: "full"; limit: number; bound: string };

/** What the host acknowledged for a draft: its revision, and the local edit it holds. */
export interface DraftHostCopy {
  revision: number;
  /** The `edit` generation this revision holds; -1 when it holds another device's. */
  edit: number;
  sessionId: string | null;
  attachmentIds: string[];
  /** The host's `updatedAt` for this revision. */
  updatedAt: number;
}

export interface ComposerDraft {
  draftId: string;
  sessionId: string | null;
  text: string;
  attachments: PendingAttachment[];
  /** Local clock of the last change: the Sessions row's age and the compare sheet's time. */
  editedAt: number;
  /** Bumped by every change to the content. */
  edit: number;
  host: DraftHostCopy | null;
  /** The host attachment id each image was uploaded as, to this draft id. */
  uploads: ReadonlyMap<PendingAttachment, string>;
  failure: DraftSaveFailure | null;
  /** A save of this draft has been in flight since then. */
  savingSince: number | null;
  /**
   * Another device's version: the same draft at a newer revision
   * (`sameId`), or a second draft for the same session. Nothing overwrites
   * either side until the reader chooses.
   */
  conflict: { other: Draft; sameId: boolean } | null;
  /** A save of this id got no answer before the host acknowledged any: it may have been stored. */
  uncertain: boolean;
  /** The accepted request that started this draft's session, to bind it on the host. */
  bind: { sessionId: string; requestId: string } | null;
}

export type DraftSendState = "pending" | "accepted" | "refused" | "unconfirmed";

/** One send: an immutable snapshot of what left the composer (D52 §5). */
export interface DraftSend {
  requestId: string;
  /** The request id it was first sent under: Send again keeps it, so the composer can follow its effort choice. */
  origin?: string;
  draftId: string;
  /** Where it was sent: its session, or null for the message that starts one. */
  sessionId: string | null;
  text: string;
  attachments: PendingAttachment[];
  /** Track files the message referenced, as the transcript draws them. */
  files?: SharedFileMeta[];
  /** The staged track entries it carried, removed only once the host accepts it. */
  tracks?: { key: string; ids: string[] };
  /** The saved revision the message names, when it was sent from one. */
  draftRef: DraftRef | null;
  /** The frame as sent, for Send again (which gives it a new `requestId`). */
  message: Extract<ClientMessage, { type: "chat_message" }>;
  state: DraftSendState;
  /** Why it is unconfirmed: the socket went, or the host refused a frame it did not name. */
  reason?: "disconnected" | "uncorrelated";
  /** What the last `Check again` found, until the next. */
  checked?: "cant_check" | "checking";
  checkReason?: string;
  acceptedSessionId?: string;
  sentAt: number;
}

export type DraftConflictChoice = "mine" | "other" | "both";

/**
 * A draft as this device kept it (#1014): its content, and the host
 * revision it last knew. `clean` says the content is that revision.
 */
export interface LocalDraft {
  draftId: string;
  sessionId: string | null;
  text: string;
  attachments: PendingAttachment[];
  editedAt: number;
  host: { revision: number; sessionId: string | null; updatedAt: number; clean: boolean } | null;
}

export interface DraftStoreState {
  drafts: Record<string, ComposerDraft>;
  /** The draft the new-chat view shows. Not stored until it has content. */
  fresh: string;
  sends: Record<string, DraftSend>;
  /** `server_hello.capabilities.sessionDrafts`; null until a hello. */
  supported: boolean | null;
  limits: SessionDraftLimits;
  /** Host drafts to delete at a revision: a rotated-away id, or the losing side of a choice. */
  orphans: Array<{ draftId: string; revision: number }>;

  /**
   * The id a draft lives under now: a rotation hands its content to a
   * successor, and a draft forgotten as its session accepted it hands later
   * work to that session's draft.
   */
  resolveId(draftId: string): string;
  /** The first id of a draft's line of rotations: what its staged tracks are kept under. */
  originOf(draftId: string): string;
  /** The root is going: previews no transcript message owns are released. */
  release(): void;
  /** The draft a view shows: its session's, or `fresh`. Pure; mints nothing into state. */
  idFor(sessionId: string | null): string;
  /** Change a draft's content; a draft emptied with nothing on the host is forgotten. */
  edit(draftId: string, sessionId: string | null, patch: { text?: string; attachments?: PendingAttachment[] }): void;
  /** These previews belong to a transcript message now: never revoked here. */
  transfer(attachments: readonly PendingAttachment[]): void;
  /** New chat: the new-chat view gets a fresh identity; the old draft stays where it is. */
  newChat(): void;
  /** Open an unbound draft in the new-chat view (a Sessions Draft entry). */
  openUnbound(draftId: string): void;
  /**
   * Drafts this device kept, after a reload (#1014). Anything this page
   * already holds is newer and stays: a kept draft only fills a gap. One
   * the host had acknowledged keeps that revision, so the host's newer
   * version replaces a clean one and meets a dirty one as a conflict.
   */
  restoreLocal(drafts: readonly LocalDraft[]): void;

  /**
   * A send left the composer: the snapshot is kept, and the draft's content
   * goes, though the host still holds the revision the message names until
   * the host consumes it. Returns the `draftRef` the message carries.
   */
  beginSend(send: Omit<DraftSend, "state" | "sentAt" | "draftRef">, consumedText: string): DraftRef | null;
  /** The frame never left: the content goes back where it was. */
  sendFailed(requestId: string): void;
  accepted(requestId: string, sessionId: string | undefined): void;
  /** The host refused it: nothing was consumed, so the content goes back. */
  refused(requestId: string): void;
  unconfirmed(reason: "disconnected" | "uncorrelated"): string[];
  /** Edit (the review block): the text and images go back into the draft. */
  editSend(requestId: string): void;
  /** Send again under a new request id; returns the message to send, or null. */
  resend(requestId: string, nextRequestId: string): DraftSend | null;
  setChecked(requestId: string, checked: DraftSend["checked"], reason?: string): void;

  // The draft client's reports.
  setSupport(supported: boolean, limits?: SessionDraftLimits): void;
  saving(draftId: string, since: number | null): void;
  saved(draftId: string, copy: DraftHostCopy, uploads: ReadonlyMap<PendingAttachment, string>): void;
  saveFailed(draftId: string, failure: DraftSaveFailure, uncertain?: boolean): void;
  uploaded(draftId: string, attachment: PendingAttachment, attachmentId: string): void;
  /** The host's uploads for this draft are gone; upload again on the next save. */
  forgetUploads(draftId: string): void;
  /** The host deleted the draft (DELETE acknowledged): it is gone here too. */
  removed(draftId: string): void;
  /**
   * The host no longer has the draft (410, or absent from the list): a
   * clean draft goes; a dirty one becomes a new unbound draft, unless this
   * page's own accepted send consumed it, when it stays its session's.
   */
  hostGone(draftId: string): void;
  /** The host has a newer version: a clean draft takes it, a dirty one is in conflict. */
  restore(draft: Draft): void;
  conflictWith(draftId: string, other: Draft, sameId: boolean): void;
  resolve(draftId: string, choice: DraftConflictChoice): void;
  bound(draftId: string, revision: number): void;
  /** A bind the host refused: the content moves to a new id of this session. */
  bindFailed(draftId: string): void;
  takeOrphans(): Array<{ draftId: string; revision: number }>;
}

/** Settled sends kept so a remounted composer can still read how its send ended. */
const SETTLED_SENDS_KEPT = 16;

/**
 * Something a reload would lose (#951): a draft the host has not
 * acknowledged as it is, or a send no answer has settled. The drafts live in
 * this root's memory, and a session's draft is not on screen while another
 * session is.
 */
export function holdsUnsaved(state: Pick<DraftStoreState, "drafts" | "sends">): boolean {
  for (const d of Object.values(state.drafts)) {
    if ((d.text.length > 0 || d.attachments.length > 0) && !(d.host !== null && d.host.edit === d.edit)) return true;
    // Emptied, with the host still holding it: the delete has not landed.
    // Or a save is out: its answer is still owed.
    if (d.conflict || d.savingSince !== null || d.uncertain || (d.host !== null && d.text.length === 0 && d.attachments.length === 0)) return true;
  }
  return Object.values(state.sends).some((s) => s.state === "pending" || s.state === "unconfirmed");
}

export const hasContent = (d: Pick<ComposerDraft, "text" | "attachments"> | undefined): boolean =>
  Boolean(d && (d.text.length > 0 || d.attachments.length > 0));

/** The draft's content is the revision the host acknowledged. */
export const isClean = (d: ComposerDraft): boolean => d.host !== null && d.host.edit === d.edit;

function blank(draftId: string, sessionId: string | null, now: number): ComposerDraft {
  return {
    draftId, sessionId, text: "", attachments: [], editedAt: now, edit: 0, host: null,
    uploads: new Map(), failure: null, savingSince: null, conflict: null, uncertain: false, bind: null,
  };
}

function fromHost(draft: Draft): ComposerDraft {
  const attachments = draft.attachments.map(attachmentFromDraft);
  return {
    ...blank(draft.draftId, draft.sessionId, draft.updatedAt),
    text: draft.text,
    attachments,
    // The host stores these images for this id already.
    uploads: new Map(attachments.map((a, i) => [a, draft.attachments[i]!.attachmentId])),
    host: hostCopy(draft, 0),
  };
}

function hostCopy(draft: Draft, edit: number): DraftHostCopy {
  return { revision: draft.revision, edit, sessionId: draft.sessionId, attachmentIds: draft.attachments.map((a) => a.attachmentId), updatedAt: draft.updatedAt };
}

export function createDraftStore(options: { now?: () => number; revoke?: (url: string) => void } = {}) {
  const now = options.now ?? Date.now;
  const revoke = options.revoke ?? ((url: string) => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
  /** Ids handed to sessions that have no stored draft yet; never stored until content. */
  const minted = new Map<string, string>();
  /** Preview URLs a send or a transcript message took; never revoked here. */
  const transferred = new Set<string>();
  /** Drafts this page's own accepted send consumed on the host. */
  const consumed = new Set<string>();
  /** Where a rotated draft's content went: async work started on the old id lands on the new one. */
  const successors = new Map<string, string>();
  /** The session a forgotten draft belonged to: late work on its id goes to that session's draft. */
  const retired = new Map<string, string>();
  const origins = new Map<string, string>();

  return createStore<DraftStoreState>((set, get) => {
    function follow(draftId: string): { id: string; owner: string | null } {
      let id = draftId;
      for (let i = 0; i < 32 && successors.has(id); i++) id = successors.get(id)!;
      const owner = retired.get(id) ?? null;
      if (owner !== null && !get().drafts[id]) return { id: get().idFor(owner), owner };
      return { id, owner: null };
    }
    const resolve = (draftId: string): string => follow(draftId).id;

    function held(draftId: string, sends = get().sends): boolean {
      return Object.values(sends).some((s) => s.draftId === draftId && (s.state === "pending" || s.state === "unconfirmed"));
    }

    function release(attachments: readonly PendingAttachment[], kept: readonly PendingAttachment[]) {
      for (const a of attachments) if (!kept.includes(a) && !transferred.has(a.previewUrl)) revoke(a.previewUrl);
    }

    function put(draft: ComposerDraft) {
      set((state) => ({
        drafts: { ...state.drafts, [draft.draftId]: draft },
        // The new-chat view never shares a draft with a session: one that
        // gains a session (bound here or on another device) leaves it.
        ...(draft.sessionId !== null && state.fresh === draft.draftId ? { fresh: mintDraftId() } : {}),
      }));
    }

    function drop(draftId: string, session: string | null = null) {
      const owner = get().drafts[draftId]?.sessionId ?? session;
      if (owner) retired.set(draftId, owner);
      set((state) => {
        const drafts = { ...state.drafts };
        const gone = drafts[draftId];
        delete drafts[draftId];
        if (gone?.sessionId) minted.delete(gone.sessionId);
        consumed.delete(draftId);
        return { drafts };
      });
    }

    /** Forget a draft that holds nothing, unless the host or a send still needs it. */
    function settle(draftId: string) {
      const d = get().drafts[draftId];
      // A save still out may yet be acknowledged: then the host has a revision to delete.
      if (d && !hasContent(d) && d.host === null && d.conflict === null && d.savingSince === null && !d.uncertain && !held(draftId)) drop(draftId);
    }

    /** The content under a new id (attachments upload again), the old id left to delete. */
    function rotate(d: ComposerDraft, sessionId: string | null): string {
      const next: ComposerDraft = { ...blank(mintDraftId(), sessionId, now()), text: d.text, attachments: d.attachments, editedAt: d.editedAt, edit: 1 };
      successors.set(d.draftId, next.draftId);
      origins.set(next.draftId, origins.get(d.draftId) ?? d.draftId);
      set((state) => {
        const drafts = { ...state.drafts, [next.draftId]: next };
        delete drafts[d.draftId];
        const fresh = state.fresh === d.draftId ? next.draftId : state.fresh;
        // Sends from the old id now belong to the new one, so Edit finds it.
        const sends = Object.fromEntries(Object.entries(state.sends).map(([id, s]) => [id, s.draftId === d.draftId ? { ...s, draftId: next.draftId } : s]));
        const orphans = d.host && !consumed.has(d.draftId) ? [...state.orphans, { draftId: d.draftId, revision: d.host.revision }] : state.orphans;
        return { drafts, fresh, sends, orphans };
      });
      consumed.delete(d.draftId);
      // A session handed the old id must not be handed it again: it is a tombstone now.
      if (d.sessionId !== null && minted.get(d.sessionId) === d.draftId) minted.delete(d.sessionId);
      return next.draftId;
    }

    function pruneSends(sends: Record<string, DraftSend>): Record<string, DraftSend> {
      const settled = Object.values(sends).filter((s) => s.state === "accepted" || s.state === "refused");
      if (settled.length <= SETTLED_SENDS_KEPT) return sends;
      const drop = new Set(settled.sort((a, b) => a.sentAt - b.sentAt).slice(0, settled.length - SETTLED_SENDS_KEPT).map((s) => s.requestId));
      return Object.fromEntries(Object.entries(sends).filter(([id]) => !drop.has(id)));
    }

    /**
     * Put a snapshot's content back into its draft, ahead of anything typed
     * since. `owned`: no transcript row shows its images any more, so the
     * draft owns their previews again and removing one may revoke it.
     */
    function giveBack(send: DraftSend, owned: boolean, settleSend: (sends: Record<string, DraftSend>) => Record<string, DraftSend>) {
      if (owned) for (const a of send.attachments) transferred.delete(a.previewUrl);
      const state = get();
      const d = state.drafts[send.draftId]
        ?? (send.sessionId ? state.drafts[state.idFor(send.sessionId)] : undefined)
        ?? blank(send.draftId, send.sessionId, now());
      const text = d.text ? (send.text ? `${send.text}\n${d.text}` : d.text) : send.text;
      // Images the transcript still shows keep their URLs there; the draft
      // gets its own previews of the same bytes, so transcript cleanup
      // cannot break the composer's.
      const returned = owned ? send.attachments : send.attachments.map((a) => ({ ...a, previewUrl: `data:${a.attachment.mediaType};base64,${a.attachment.data}` }));
      const attachments = [...returned, ...d.attachments.filter((a) => !send.attachments.includes(a))];
      const back = { ...d, text, attachments, edit: d.edit + 1, editedAt: now() };
      // One change: the content is back in the draft in the same state that
      // settles the send, so nothing observing the store ever sees neither.
      set((s) => ({ drafts: { ...s.drafts, [back.draftId]: back }, sends: settleSend(s.sends) }));
    }
    const without = (requestId: string) => (sends: Record<string, DraftSend>) => {
      const next = { ...sends };
      delete next[requestId];
      return next;
    };

    return {
      drafts: {},
      fresh: mintDraftId(),
      sends: {},
      supported: null,
      limits: { ...SESSION_DRAFT_LIMITS },
      orphans: [],

      idFor(sessionId) {
        const state = get();
        if (sessionId === null) return state.fresh;
        let best: ComposerDraft | undefined;
        for (const d of Object.values(state.drafts)) {
          if (d.sessionId === sessionId && (!best || d.editedAt > best.editedAt)) best = d;
        }
        if (best) return best.draftId;
        let id = minted.get(sessionId);
        if (!id) { id = mintDraftId(); minted.set(sessionId, id); }
        return id;
      },

      resolveId: resolve,
      originOf: (draftId) => origins.get(draftId) ?? draftId,

      release() {
        for (const d of Object.values(get().drafts)) release(d.attachments, []);
        // A held send's rows left the transcript: its snapshot alone owns its previews.
        for (const s of Object.values(get().sends)) if (s.state === "unconfirmed") for (const a of s.attachments) revoke(a.previewUrl);
        minted.clear(); transferred.clear(); consumed.clear(); successors.clear(); retired.clear(); origins.clear();
      },

      edit(requested, requestedSession, patch) {
        // Late work for a rotated draft, or one forgotten as its session accepted it.
        const { id: draftId, owner } = follow(requested);
        const sessionId = get().drafts[draftId]?.sessionId ?? owner ?? requestedSession;
        const current = get().drafts[draftId] ?? blank(draftId, sessionId, now());
        const text = patch.text ?? current.text;
        const attachments = patch.attachments ?? current.attachments;
        if (text === current.text && attachments === current.attachments) return;
        if (patch.attachments) release(current.attachments, attachments);
        put({ ...current, text, attachments, edit: current.edit + 1, editedAt: now(), failure: current.failure?.kind === "unsaved" ? current.failure : null });
        settle(draftId);
      },

      transfer(attachments) {
        for (const a of attachments) transferred.add(a.previewUrl);
      },

      newChat() {
        // A fresh identity is not stored until it has content, so repeated
        // empty New chats leave nothing behind.
        set({ fresh: mintDraftId() });
      },

      openUnbound(draftId) {
        // A new chat holding only staged tracks has no stored draft (#1112):
        // its view opens under the id its work lives under now, never a
        // session's.
        const { id, owner } = follow(draftId);
        if (owner !== null || (get().drafts[id] && get().drafts[id]!.sessionId !== null)) return;
        set({ fresh: id });
      },

      restoreLocal(kept) {
        for (const k of kept) {
          const state = get();
          if (state.drafts[k.draftId] || successors.has(k.draftId) || retired.has(k.draftId)) continue;
          // An emptied draft comes back only while its deletion is owed to the host.
          if (k.text.length === 0 && k.attachments.length === 0 && !(k.host && !k.host.clean)) continue;
          // A session whose draft this page already holds keeps that one.
          if (k.sessionId !== null && Object.values(state.drafts).some((d) => d.sessionId === k.sessionId && (hasContent(d) || d.host))) continue;
          // An id handed to the session before this arrived goes to it, as in
          // `restore`: work begun on it (an image decoding) lands here.
          if (k.sessionId !== null) {
            const handed = minted.get(k.sessionId);
            if (handed && !state.drafts[handed]) { successors.set(handed, k.draftId); minted.delete(k.sessionId); }
          }
          const edit = 1;
          put({
            ...blank(k.draftId, k.sessionId, k.editedAt),
            text: k.text,
            attachments: k.attachments,
            edit,
            // Its images upload again before the next save: the ids they had are not kept.
            host: k.host ? { revision: k.host.revision, edit: k.host.clean ? edit : edit - 1, sessionId: k.host.sessionId, attachmentIds: [], updatedAt: k.host.updatedAt } : null,
          });
        }
      },

      beginSend(input, consumedText) {
        const state = get();
        const d = state.drafts[input.draftId];
        // A saved revision is named only when the host holds exactly what is
        // sent: then accepting the message consumes it there, atomically.
        const draftRef = state.supported && d && isClean(d) && d.conflict === null && d.host
          ? { draftId: d.draftId, revision: d.host.revision } : null;
        for (const a of input.attachments) transferred.add(a.previewUrl);
        const send: DraftSend = { ...input, origin: input.requestId, draftRef, state: "pending", sentAt: now(), ...(draftRef ? { message: { ...input.message, draftRef } } : {}) };
        set((s) => ({ sends: pruneSends({ ...s.sends, [input.requestId]: send }) }));
        if (d) {
          const remaining = d.attachments.filter((a) => !input.attachments.includes(a));
          const text = d.text === consumedText ? "" : d.text;
          put({ ...d, text, attachments: remaining, edit: d.edit + 1, editedAt: now() });
        }
        return draftRef;
      },

      sendFailed(requestId) {
        const send = get().sends[requestId];
        if (!send) return;
        giveBack(send, true, without(requestId));
      },

      accepted(requestId, sessionId) {
        const send = get().sends[requestId];
        if (!send || send.state === "accepted" || send.state === "refused") return;
        const acceptedSessionId = sessionId ?? send.sessionId ?? undefined;
        set((s) => ({ sends: { ...s.sends, [requestId]: { ...send, state: "accepted", ...(acceptedSessionId ? { acceptedSessionId } : {}) } } }));
        const d = get().drafts[send.draftId];
        if (!d) return;
        // An unbound draft's first message named a session: the draft is
        // that session's now, whatever view the reader has moved on to.
        const session = d.sessionId ?? acceptedSessionId ?? null;
        const wasConsumed = send.draftRef !== null && send.draftRef.draftId === d.draftId && d.host?.revision === send.draftRef.revision;
        if (wasConsumed && d.savingSince !== null) {
          // A save is out: the host may have stored a newer revision before
          // it accepted the message, and kept it. Its answer decides; a new
          // chat's draft keeps the proof to bind it if the host kept it.
          consumed.add(d.draftId);
          put({ ...d, sessionId: session, ...(d.sessionId === null && session !== null ? { bind: { sessionId: session, requestId } } : {}) });
          return;
        }
        if (wasConsumed) {
          consumed.add(d.draftId);
          if (!hasContent(d) && !held(d.draftId)) { drop(d.draftId, session); return; }
          // Edits made after submitting become the next revision, under a
          // new id: the host's row for this one is a tombstone now.
          put({ ...d, sessionId: session });
          rotate(get().drafts[d.draftId]!, session);
          return;
        }
        if (d.host && d.host.sessionId !== session && session !== null) {
          if (!hasContent(d)) { put({ ...d, sessionId: session }); return; }
          // Only a message that named this draft is the host's proof to bind it.
          if (send.draftRef) { put({ ...d, sessionId: session, bind: { sessionId: session, requestId } }); return; }
          put({ ...d, sessionId: session });
          rotate(get().drafts[d.draftId]!, session);
          return;
        }
        put({ ...d, sessionId: session });
        settle(d.draftId);
      },


      refused(requestId) {
        const send = get().sends[requestId];
        if (!send || send.state === "accepted" || send.state === "refused") return;
        // The refused message stays in the transcript, its images with it.
        giveBack(send, false, (sends) => ({ ...sends, [requestId]: { ...send, state: "refused" } }));
      },

      unconfirmed(reason) {
        const pending = Object.values(get().sends).filter((s) => s.state === "pending");
        if (pending.length === 0) return [];
        set((s) => ({
          sends: { ...s.sends, ...Object.fromEntries(pending.map((p) => [p.requestId, { ...p, state: "unconfirmed" as const, reason }])) },
        }));
        return pending.map((p) => p.requestId);
      },

      editSend(requestId) {
        const send = get().sends[requestId];
        if (!send || send.state !== "unconfirmed") return;
        // A new chat's first message goes back to its own draft, which the new-chat view then shows.
        if (send.sessionId === null) set({ fresh: send.draftId });
        giveBack(send, true, without(requestId));
      },

      resend(requestId, nextRequestId) {
        const state = get();
        const send = state.sends[requestId];
        if (!send || send.state !== "unconfirmed") return null;
        const d = state.drafts[send.draftId];
        // The revision is named again only while the host still holds it.
        const draftRef = send.draftRef && send.draftRef.draftId === d?.draftId && d.host?.revision === send.draftRef.revision ? send.draftRef : null;
        const { draftRef: _old, ...message } = send.message;
        const next: DraftSend = {
          ...send,
          requestId: nextRequestId,
          draftRef,
          message: { ...message, requestId: nextRequestId, ...(draftRef ? { draftRef } : {}) },
          state: "pending",
          sentAt: now(),
        };
        delete next.reason;
        delete next.checked;
        delete next.checkReason;
        set((s) => {
          const sends = { ...s.sends, [nextRequestId]: next };
          delete sends[requestId];
          return { sends };
        });
        return next;
      },

      setChecked(requestId, checked, reason) {
        const send = get().sends[requestId];
        if (!send) return;
        const next = { ...send, checked };
        if (reason) next.checkReason = reason;
        else delete next.checkReason;
        set((s) => ({ sends: { ...s.sends, [requestId]: next } }));
      },

      setSupport(supported, limits) {
        set({ supported, limits: limits ? { ...limits } : { ...SESSION_DRAFT_LIMITS } });
      },

      saving(draftId, since) {
        const d = get().drafts[draftId];
        if (d && d.savingSince !== since) put({ ...d, savingSince: since });
        if (since === null) settle(draftId);
      },

      saved(draftId, copy, uploads) {
        const d = get().drafts[draftId];
        if (!d) return;
        // Uploads the saved revision does not list were removed with it.
        const listed = new Set(copy.attachmentIds);
        const kept = new Map([...uploads].filter(([, id]) => listed.has(id)));
        for (const [a, id] of d.uploads) if (!kept.has(a) && d.attachments.includes(a) && !listed.has(id)) kept.set(a, id);
        // A revision acknowledged after this page's send was accepted is the
        // host's newer one: that send did not consume it.
        if (copy.revision > (d.host?.revision ?? 0)) consumed.delete(draftId);
        put({ ...d, host: copy, uploads: kept, failure: null, savingSince: null, uncertain: false });
        // Acknowledged unbound after this page's send bound the draft to a
        // session: no message named this revision, so nothing can bind it.
        // The content moves to a new id of that session; the old one goes.
        if (d.sessionId !== null && copy.sessionId !== d.sessionId && !d.bind) {
          rotate(get().drafts[draftId]!, d.sessionId);
          return;
        }
        settle(draftId);
      },

      saveFailed(draftId, failure, uncertain) {
        const d = get().drafts[draftId];
        if (d) put({ ...d, failure, savingSince: null, ...(uncertain && d.host === null ? { uncertain: true } : {}) });
      },

      uploaded(draftId, attachment, attachmentId) {
        const d = get().drafts[draftId];
        if (!d) return;
        const uploads = new Map(d.uploads);
        uploads.set(attachment, attachmentId);
        put({ ...d, uploads });
      },

      forgetUploads(draftId) {
        const d = get().drafts[draftId];
        if (d && d.uploads.size > 0) put({ ...d, uploads: new Map() });
      },

      removed(draftId) {
        const d = get().drafts[draftId];
        if (!d) return;
        if (!hasContent(d)) {
          if (held(draftId)) put({ ...d, host: null, uploads: new Map(), savingSince: null });
          else drop(draftId);
          return;
        }
        // Typed again while the delete was out: the id is a tombstone now,
        // so the new words move to a new id of the same session.
        put({ ...d, host: null, uploads: new Map(), savingSince: null });
        rotate(get().drafts[draftId]!, d.sessionId);
      },

      hostGone(draftId) {
        const d = get().drafts[draftId];
        if (!d) return;
        if (!hasContent(d)) {
          if (held(draftId)) put({ ...d, host: null, uploads: new Map() });
          else drop(draftId);
          return;
        }
        if (d.host && isClean(d) && !held(draftId)) {
          // Deleted or sent on another device, with nothing new here.
          release(d.attachments, []);
          drop(draftId);
          return;
        }
        // Dirty content is never lost. The host's tombstone stops this id
        // from being saved again; the content becomes a new draft.
        const own = consumed.has(draftId);
        consumed.add(draftId);
        rotate(d, own ? d.sessionId : null);
      },

      restore(draft) {
        const state = get();
        const local = state.drafts[draft.draftId];
        if (!local) {
          // A second draft for a session that already keeps one here is a
          // conflict on that one, never a silent switch under the reader.
          if (draft.sessionId !== null) {
            const mine = Object.values(state.drafts).find((d) => d.sessionId === draft.sessionId && (hasContent(d) || d.host));
            if (mine) { get().conflictWith(mine.draftId, draft, false); return; }
          }
          // An id handed to the session before its draft arrived goes to this
          // one: work begun on it (an image decoding) lands here.
          if (draft.sessionId !== null) {
            const handed = minted.get(draft.sessionId);
            if (handed && !state.drafts[handed]) { successors.set(handed, draft.draftId); minted.delete(draft.sessionId); }
          }
          put(fromHost(draft));
          return;
        }
        if (local.host && local.host.revision >= draft.revision) return;
        if (local.conflict?.sameId && local.conflict.other.revision >= draft.revision) return;
        // The host holds exactly what is here (a save whose answer was lost):
        // that is an acknowledgement, not another device's version.
        if (local.text === draft.text && local.attachments.length === draft.attachments.length
          && local.attachments.every((a, i) => a.attachment.data === draft.attachments[i]!.bytes)) {
          // Bound on another device meanwhile: it is that session's draft here too.
          put({ ...local, sessionId: local.sessionId ?? draft.sessionId, host: hostCopy(draft, local.edit), uploads: new Map(local.attachments.map((a, i) => [a, draft.attachments[i]!.attachmentId])), failure: null, uncertain: false });
          return;
        }
        // A host refresh never overwrites dirty visible content (D52 §5).
        if ((local.host && !isClean(local)) || (!local.host && hasContent(local))) {
          get().conflictWith(local.draftId, draft, true);
          return;
        }
        release(local.attachments, []);
        put({ ...fromHost(draft), edit: local.edit + 1, host: hostCopy(draft, local.edit + 1) });
      },

      conflictWith(draftId, other, sameId) {
        const d = get().drafts[draftId];
        if (d) put({ ...d, conflict: { other, sameId }, savingSince: null });
      },

      resolve(draftId, choice) {
        const d = get().drafts[draftId];
        if (!d?.conflict) return;
        const { other, sameId } = d.conflict;
        const otherHost = hostCopy(other, -1);
        const orphan = (draftId: string, revision: number) => set((s) => ({ orphans: [...s.orphans, { draftId, revision }] }));
        if (choice === "other") {
          release(d.attachments, []);
          if (sameId) {
            put({ ...fromHost(other), edit: d.edit + 1, host: hostCopy(other, d.edit + 1) });
            return;
          }
          // The other device's draft is this session's draft now; this one goes.
          if (d.host) orphan(d.draftId, d.host.revision);
          drop(d.draftId);
          put(fromHost(other));
          return;
        }
        if (choice === "both") {
          // The other version becomes an unbound Draft entry of its own.
          const copy: ComposerDraft = { ...blank(mintDraftId(), null, now()), text: other.text, attachments: other.attachments.map(attachmentFromDraft), editedAt: other.updatedAt, edit: 1 };
          put(copy);
          if (!sameId) orphan(other.draftId, other.revision);
        } else if (!sameId) {
          orphan(other.draftId, other.revision);
        }
        const current = get().drafts[draftId]!;
        // Keeping this device's: the next save writes over the host's
        // revision, on purpose. Its images upload again, since the other
        // device's save may have dropped them.
        put(sameId
          ? { ...current, conflict: null, host: otherHost, uploads: new Map(), failure: null }
          : { ...current, conflict: null, failure: null });
      },

      bound(draftId, revision) {
        const d = get().drafts[draftId];
        if (!d?.host || !d.bind) return;
        put({ ...d, bind: null, host: { ...d.host, revision, sessionId: d.bind.sessionId } });
      },

      bindFailed(draftId) {
        const d = get().drafts[draftId];
        if (!d) return;
        put({ ...d, bind: null });
        rotate(get().drafts[draftId]!, d.sessionId);
      },

      takeOrphans() {
        const orphans = get().orphans;
        if (orphans.length > 0) set({ orphans: [] });
        return orphans;
      },
    };
  });
}

export type DraftStore = ReturnType<typeof createDraftStore>;
