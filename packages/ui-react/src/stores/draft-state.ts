import { createStore } from "zustand/vanilla";
import {
  SESSION_DRAFT_LIMITS,
  type ClientMessage,
  type Draft,
  type DraftRef,
  type AttachmentFile,
  type AttachmentLimits,
  type SessionDraftLimits,
  type SharedFileMeta,
  type DraftSnapshot,
  type DraftSnapshotState,
  type DraftSnapshotWrite,
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

type DraftSaveFailure =
  /**
   * Dirty and unreachable, or a transient refusal: retried with backoff.
   * `lost`: the request got no answer at all, so the host may hold it
   * (#3155); Check again reads the draft to find out.
   */
  | { kind: "unsaved"; lost?: true }
  /** 413: `limit` bytes (or images), named by `bound`. */
  | { kind: "too_large"; limit: number; bound: string }
  /** 507: the host keeps `limit` drafts, or bytes, already. */
  | { kind: "full"; limit: number; bound: string };

/**
 * A composer original the host stored for a draft (#3155). `lineage` is the
 * draft id it was uploaded to: the host binds a file only to that draft, so
 * one carried to another id (a rotation, a kept copy) cannot be saved or
 * sent there, and reads as needing to be chosen again.
 */
export interface DraftFile {
  file: AttachmentFile;
  lineage: string;
}

const NO_FILES: readonly DraftFile[] = [];
/** A draft's originals; none when it was built without the field. */
export const draftFiles = (d: Pick<ComposerDraft, "files"> | undefined): readonly DraftFile[] => d?.files ?? NO_FILES;
/** The originals of a draft its own id can bind. */
export const bindableFiles = (d: Pick<ComposerDraft, "draftId" | "files">): DraftFile[] => draftFiles(d).filter((f) => f.lineage === d.draftId);

/** Why a snapshot came back unsent. Local: a snapshot restored after a reload says only "Not sent". */
type SnapshotReturn =
  | { kind: "cancelled" }
  /** A file it waited for was not stored, or the host refused the message. */
  | { kind: "failed" | "refused"; file?: string; reason: string };

/**
 * One outgoing snapshot of a draft (#3155, design brief rev 5 §2): the exact
 * text and files of one send that is held, returned unsent, or dispatched
 * and not yet confirmed. The host keeps the list (`Draft.snapshots`); every
 * save writes all of it. Fields marked local never reach the host.
 */
export interface ComposerSnapshot {
  snapshotId: string;
  requestId: string;
  text: string;
  /** Its stored originals, in order. `file` is the host's record when this tab saw it; a restored one names only the id. */
  files: { fileId: string; file?: AttachmentFile }[];
  state: DraftSnapshotState;
  /** The host's creation time, once known. */
  createdAt: number | null;
  /** Local: queue items still uploading for this held snapshot. */
  uploads?: string[];
  /** Local: why it returned. */
  why?: SnapshotReturn;
  /** Local: a held snapshot restored after a reload. It waits for an explicit Send. */
  paused?: boolean;
  /** Local: this tab owes its `chat_message` once the host holds it dispatched (`due`), or sent it (`sent`). */
  dispatch?: "due" | "sent";
  /** Local: the frame as composed at Send, without `draftRef` and `attachmentRefs`. */
  message?: Extract<ClientMessage, { type: "chat_message" }>;
  /** Local: Send again replaces this snapshot, which is returned and deleted first. */
  replaces?: string;
  /** Local: replaced by Send again; returned, then left out of the list. Never drawn. */
  retiring?: boolean;
}

/** A snapshot as a save names it. */
const snapshotWrite = (s: ComposerSnapshot, state: DraftSnapshotState = s.state): DraftSnapshotWrite =>
  ({ snapshotId: s.snapshotId, requestId: s.requestId, text: s.text, fileIds: s.files.map((f) => f.fileId), state });

const NO_SNAPSHOTS: readonly ComposerSnapshot[] = [];
/** A draft's snapshots; none when it was built without the field. */
export const draftSnapshots = (d: Pick<ComposerDraft, "snapshots"> | undefined): readonly ComposerSnapshot[] => d?.snapshots ?? NO_SNAPSHOTS;
/** The draft holds snapshots, here or on the host: it is never deleted as empty. */
export const holdsSnapshots = (d: Pick<ComposerDraft, "snapshots" | "host">): boolean =>
  draftSnapshots(d).length > 0 || (d.host?.snapshots?.length ?? 0) > 0;

/**
 * The list the next save writes, and whether it is the whole local list.
 * Send again is two saves, because only a returned snapshot may be left out:
 * the replaced one is returned first, then dropped as its successor is
 * created, so the swap never needs a free slot.
 */
export function snapshotSaveList(d: Pick<ComposerDraft, "snapshots" | "host">): { writes: DraftSnapshotWrite[]; complete: boolean } {
  const host = new Map((d.host?.snapshots ?? []).map((s) => [s.snapshotId, s]));
  const writes: DraftSnapshotWrite[] = [];
  let complete = true;
  for (const s of draftSnapshots(d)) {
    if (s.retiring) {
      const stored = host.get(s.snapshotId);
      if (!stored || stored.state === "returned") continue;
      writes.push(snapshotWrite(s, "returned"));
      complete = false;
      continue;
    }
    // Created in the same save that drops the returned one: the slot passes straight across.
    if (s.replaces && host.has(s.replaces) && host.get(s.replaces)!.state !== "returned") { complete = false; continue; }
    writes.push(snapshotWrite(s));
  }
  return { writes, complete };
}

/** A host list as this tab keeps it: held ones restored are paused, and what this tab knew of each is kept. */
function mergeSnapshots(local: readonly ComposerSnapshot[] | undefined, host: readonly DraftSnapshot[] | undefined): ComposerSnapshot[] {
  const known = new Map((local ?? []).map((s) => [s.snapshotId, s]));
  return (host ?? []).map((h) => {
    const mine = known.get(h.snapshotId);
    const files = h.fileIds.map((fileId) => ({ fileId, ...(mine?.files.find((f) => f.fileId === fileId)?.file ? { file: mine.files.find((f) => f.fileId === fileId)!.file } : {}) }));
    if (!mine) return { snapshotId: h.snapshotId, requestId: h.requestId, text: h.text, files, state: h.state, createdAt: h.createdAt, ...(h.state === "held" ? { paused: true } : {}) };
    const { uploads, why, paused, dispatch, message, replaces } = mine;
    return {
      snapshotId: h.snapshotId, requestId: h.requestId, text: h.text, files, state: h.state, createdAt: h.createdAt,
      ...(h.state === "held" && uploads ? { uploads } : {}), ...(h.state === "returned" && why ? { why } : {}),
      ...(h.state === "held" && paused ? { paused } : {}), ...(dispatch ? { dispatch } : {}), ...(message ? { message } : {}), ...(replaces ? { replaces } : {}),
    };
  });
}

/** What the host acknowledged for a draft: its revision, and the local edit it holds. */
interface DraftHostCopy {
  revision: number;
  /** The `edit` generation this revision holds; -1 when it holds another device's. */
  edit: number;
  sessionId: string | null;
  attachmentIds: string[];
  /** The originals this revision binds (#3155); absent on a host without composer files. */
  fileIds?: string[];
  /** The snapshot list this revision holds (#3155); absent on a host without snapshots. */
  snapshots?: DraftSnapshotWrite[];
  /** The host's `updatedAt` for this revision. */
  updatedAt: number;
}

export interface ComposerDraft {
  draftId: string;
  sessionId: string | null;
  text: string;
  attachments: PendingAttachment[];
  /**
   * Stored composer originals, in display order (#3155). Saved only when
   * `host.fileIds` lists them. Optional: a draft built by older code or a
   * kept device record has none; read it through `draftFiles`.
   */
  files?: DraftFile[];
  /**
   * Outgoing snapshots, oldest first (#3155). Saved with the draft: a change
   * bumps `edit` like any content. Optional; read it through `draftSnapshots`.
   */
  snapshots?: ComposerSnapshot[];
  /** Local clock of the last change: the Sessions row's age and the compare sheet's time. */
  editedAt: number;
  /** A locally accepted transcript waits for a user edit/send before host sync. */
  deviceOnly?: boolean;
  /** @internal A committed device adoption fences older host operations. */
  deviceEpoch?: number;
  /** @internal A device-local keep-both branch; its other version stays reachable. */
  deviceConflict?: { otherId: string; sessionId: string | null };
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

type DraftSendState = "pending" | "accepted" | "refused" | "unconfirmed";

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
  /** Composer originals the message named in `attachmentRefs` (#3155). */
  attachmentFiles?: DraftFile[];
  /** The staged track entries it carried, removed only once the host accepts it. */
  tracks?: { key: string; ids: string[] };
  /** The outgoing snapshot it sends (#3155): its bubble, not a review block, stands for it. */
  snapshotId?: string;
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
  /** Stored originals, by reference (#3155): the bytes stay on the host. */
  files?: DraftFile[];
  editedAt: number;
  /** A locally accepted transcript waits for a user edit/send before host sync. */
  deviceOnly?: boolean;
  /** @internal A device-local keep-both branch; its other version stays reachable. */
  deviceConflict?: { otherId: string; sessionId: string | null };
  host: { revision: number; sessionId: string | null; updatedAt: number; clean: boolean } | null;
  /** A first save got no answer: the host may hold it, and a reconciliation is owed (#1214). */
  uncertain?: boolean;
  /** An accepted first message's session, still to be bound on the host (#1214). */
  bind?: { sessionId: string; requestId: string } | null;
}

export interface DraftStoreState {
  drafts: Record<string, ComposerDraft>;
  /** The draft the new-chat view shows. Not stored until it has content. */
  fresh: string;
  sends: Record<string, DraftSend>;
  /** `server_hello.capabilities.sessionDrafts`; null until a hello. */
  supported: boolean | null;
  limits: SessionDraftLimits;
  /** `server_hello.attachmentLimits` when the host keeps composer originals (`composerFiles`); else null. */
  fileLimits: AttachmentLimits | null;
  /** Host drafts to delete at a revision: a rotated-away id, or the losing side of a choice. */
  orphans: Array<{ draftId: string; revision: number }>;
  /**
   * The host keeps outgoing snapshots (#3155): it advertises `composerFiles`
   * and `sessionDraftLimits.maxOutgoingSnapshots`. Off, a send keeps D52's
   * tab-local path.
   */
  snapshotsOn: boolean;
  /**
   * The last creating save this tab made was refused with `409
   * DRAFT_OUTGOING_FULL` (#3155): the chat it names shows the queue-full
   * notice until this tab frees a slot.
   */
  outgoingFull: { draftId: string; sessionId: string | null; limit: number } | null;

  /**
   * The id a draft lives under now: a rotation hands its content to a
   * successor, and a draft forgotten as its session accepted it hands later
   * work to that session's draft.
   */
  resolveId(draftId: string): string;
  /** Associate retained composer content with the session created by an accepted voice request. */
  associateVoice(draftId: string, sessionId: string, requestId: string, sourceSessionId?: string): void;
  /** Resolve a late write's identity and session together, including retired drafts. */
  resolveTarget(draftId: string, sessionId: string | null): { draftId: string; sessionId: string | null };
  /** The first id of a draft's line of rotations: what its staged tracks are kept under. */
  originOf(draftId: string): string;
  /** @internal The editable target of an immutable send snapshot. */
  sendDraftId(requestId: string): string | undefined;
  /** The root is going: previews no transcript message owns are released. */
  release(): void;
  /** The draft a view shows: its session's, or `fresh`. Pure; mints nothing into state. */
  idFor(sessionId: string | null): string;
  /** Change a draft's content; a draft emptied with nothing on the host is forgotten. */
  edit(draftId: string, sessionId: string | null, patch: { text?: string; attachments?: PendingAttachment[]; files?: DraftFile[]; deviceOnly?: boolean }): void;
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
  /** The host refused it: nothing was consumed, so the content goes back. `reason` replaces the generic copy. */
  refused(requestId: string, reason?: string): void;
  unconfirmed(reason: "disconnected" | "uncorrelated"): string[];
  /** Edit (the review block): the text and images go back into the draft. */
  editSend(requestId: string): void;
  /** Send again under a new request id; returns the message to send, or null. */
  resend(requestId: string, nextRequestId: string): DraftSend | null;
  setChecked(requestId: string, checked: DraftSend["checked"], reason?: string): void;

  // Outgoing snapshots (#3155). Each change is the draft's next revision.
  /** Send: the snapshot joins the list and its text and files leave the composer, in one change. */
  createSnapshot(draftId: string, sessionId: string | null, snapshot: ComposerSnapshot, consumedText: string): void;
  /** Change one snapshot. `local` keeps it out of the next save (a field the host never sees). */
  patchSnapshot(draftId: string, snapshotId: string, patch: Partial<ComposerSnapshot>, local?: boolean): void;
  /** The creating save was refused at the chat's limit: nothing was sent, and the content goes back. */
  snapshotsRefused(draftId: string, snapshotIds: readonly string[], limit: number): void;
  /** One of a held snapshot's uploads was stored: it binds the file. */
  snapshotStored(draftId: string, snapshotId: string, itemId: string, file: AttachmentFile): void;
  /** One of a held snapshot's uploads was not stored: it returns, naming the file. */
  snapshotUploadFailed(draftId: string, snapshotId: string, itemId: string, why: SnapshotReturn): void;
  /** Edit: a returned snapshot moves into the empty composer. False when the composer holds anything. */
  editSnapshot(draftId: string, snapshotId: string): boolean;
  /** Delete…: a returned snapshot leaves the list. */
  deleteSnapshot(draftId: string, snapshotId: string): void;
  /** Send again: a new request replaces a dispatched snapshot that no answer settled. */
  resendSnapshot(draftId: string, snapshotId: string, next: { snapshotId: string; requestId: string; message: DraftSend["message"] }): void;
  /** The host has no record of an acknowledged snapshot: only acceptance releases a held or dispatched one. */
  snapshotReleased(draftId: string, requestId: string): void;
  /** A send of this snapshot left the composer; registered without touching the composer's content. */
  beginSnapshotSend(send: Omit<DraftSend, "state" | "sentAt"> & { unconfirmedAs?: "disconnected" }): void;
  clearOutgoingFull(): void;

  /** @internal Retarget this tab after a committed device-local fork. */
  keepDeviceBranch(sourceId: string, branchId: string, other: LocalDraft | null, sessionId: string | null, preserveOther?: boolean): void;
  /** @internal Adopt a committed owner without changing this tab's selected view. */
  adoptDeviceRecord(kept: LocalDraft): void;
  /** @internal Restore this tab's association without binding the branch to a session. */
  showDeviceBranch(sessionId: string, draftId: string): void;
  /** @internal Explicitly open the other retained version. */
  openDeviceVersion(draftId: string, kept?: LocalDraft): void;

  // The draft client's reports.
  setSupport(supported: boolean, limits?: SessionDraftLimits, fileLimits?: AttachmentLimits | null, snapshotsOn?: boolean): void;
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
    if (hasContent(d) && !(d.host !== null && d.host.edit === d.edit)) return true;
    // Emptied, with the host still holding it: the delete has not landed.
    // Or a save is out: its answer is still owed.
    if (d.conflict || d.savingSince !== null || d.uncertain || (d.host !== null && !hasContent(d))) return true;
  }
  // A snapshot's send is durable on the host, whatever this page does.
  return Object.values(state.sends).some((s) => !s.snapshotId && (s.state === "pending" || s.state === "unconfirmed"));
}

export const hasContent = (d: (Pick<ComposerDraft, "text" | "attachments"> & { files?: readonly DraftFile[] }) | undefined): boolean =>
  Boolean(d && (d.text.length > 0 || d.attachments.length > 0 || (d.files?.length ?? 0) > 0));

/** The draft's content is the revision the host acknowledged. */
const isClean = (d: ComposerDraft): boolean => d.host !== null && d.host.edit === d.edit;

function blank(draftId: string, sessionId: string | null, now: number): ComposerDraft {
  return {
    draftId, sessionId, text: "", attachments: [], files: [], editedAt: now, edit: 0, host: null,
    uploads: new Map(), failure: null, savingSince: null, conflict: null, uncertain: false, bind: null,
  };
}

function fromHost(draft: Draft): ComposerDraft {
  const attachments = draft.attachments.map(attachmentFromDraft);
  return {
    ...blank(draft.draftId, draft.sessionId, draft.updatedAt),
    text: draft.text,
    attachments,
    files: (draft.files ?? []).map((file) => ({ file, lineage: draft.draftId })),
    ...(draft.snapshots?.length ? { snapshots: mergeSnapshots(undefined, draft.snapshots) } : {}),
    // The host stores these images for this id already.
    uploads: new Map(attachments.map((a, i) => [a, draft.attachments[i]!.attachmentId])),
    host: hostCopy(draft, 0),
  };
}

function hostCopy(draft: Draft, edit: number): DraftHostCopy {
  return {
    revision: draft.revision, edit, sessionId: draft.sessionId, attachmentIds: draft.attachments.map((a) => a.attachmentId), ...(draft.files ? { fileIds: draft.files.map((f) => f.fileId) } : {}),
    ...(draft.snapshots?.length ? { snapshots: draft.snapshots.map(({ createdAt: _at, ...write }) => ({ ...write, fileIds: [...write.fileIds] })) } : {}),
    updatedAt: draft.updatedAt,
  };
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
  const deviceViews = new Map<string, string>();
  const deviceRedirects = new Map<string, string>();
  const sendTargets = new Map<string, string>();

  return createStore<DraftStoreState>((set, get) => {
    function follow(draftId: string): { id: string; owner: string | null } {
      let id = draftId;
      const visited = new Set<string>();
      // Legitimate continuations have no length limit; only a cycle stops us.
      while (!visited.has(id) && (successors.has(id) || deviceRedirects.has(id))) {
        visited.add(id);
        id = deviceRedirects.get(id) ?? successors.get(id)!;
      }
      const owner = retired.get(id) ?? null;
      if (owner !== null && !get().drafts[id]) return { id: get().idFor(owner), owner };
      return { id, owner: null };
    }
    const resolve = (draftId: string): string => follow(draftId).id;
    const sendTarget = (send: DraftSend) => resolve(sendTargets.get(send.requestId) ?? send.draftId);
    const resolveTarget = (requested: string, requestedSession: string | null) => {
      const { id, owner } = follow(requested);
      const current = get().drafts[id];
      return { draftId: id, sessionId: current ? current.sessionId : owner ?? requestedSession };
    };

    function held(draftId: string, sends = get().sends): boolean {
      return Object.values(sends).some((s) => (s.draftId === draftId || sendTarget(s) === draftId) && (s.state === "pending" || s.state === "unconfirmed"));
    }

    function release(attachments: readonly PendingAttachment[], kept: readonly PendingAttachment[]) {
      for (const a of attachments) if (!kept.includes(a) && !transferred.has(a.previewUrl)) revoke(a.previewUrl);
    }

    function put(draft: ComposerDraft) {
      if (draft.deviceConflict && draft.sessionId !== null) {
        // A retained Draft explicitly sent as a new conversation now owns
        // that session. The original session goes back to its own version.
        for (const [session, branch] of deviceViews) if (resolve(branch) === draft.draftId) deviceViews.delete(session);
        successors.delete(draft.deviceConflict.otherId);
        deviceRedirects.delete(draft.deviceConflict.otherId);
      }
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
      if (d && !hasContent(d) && !holdsSnapshots(d) && d.host === null && d.conflict === null && !d.deviceConflict && d.savingSince === null && !d.uncertain && !held(draftId)) drop(draftId);
    }

    /** The content under a new id (attachments upload again), the old id left to delete. */
    function rotate(d: ComposerDraft, sessionId: string | null): string {
      // Originals keep their lineage: the new id cannot bind them, so they read as needing to be chosen again.
      const next: ComposerDraft = { ...blank(mintDraftId(), sessionId, now()), text: d.text, attachments: d.attachments, files: d.files, editedAt: d.editedAt, edit: 1, deviceOnly: d.deviceOnly, deviceConflict: d.deviceConflict };
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
      for (const id of drop) sendTargets.delete(id);
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
      const d = state.drafts[sendTarget(send)]
        ?? (send.sessionId ? state.drafts[state.idFor(send.sessionId)] : undefined)
        ?? blank(send.draftId, send.sessionId, now());
      const text = d.text ? (send.text ? `${send.text}\n${d.text}` : d.text) : send.text;
      // Images the transcript still shows keep their URLs there; the draft
      // gets its own previews of the same bytes, so transcript cleanup
      // cannot break the composer's.
      const returned = owned ? send.attachments : send.attachments.map((a) => ({ ...a, previewUrl: `data:${a.attachment.mediaType};base64,${a.attachment.data}` }));
      const attachments = [...returned, ...d.attachments.filter((a) => !send.attachments.includes(a))];
      const sentFiles = send.attachmentFiles ?? [];
      const files = [...sentFiles, ...draftFiles(d).filter((f) => !sentFiles.some((s) => s.file.fileId === f.file.fileId))];
      const back = { ...d, text, attachments, files, edit: d.edit + 1, editedAt: now() };
      // One change: the content is back in the draft in the same state that
      // settles the send, so nothing observing the store ever sees neither.
      set((s) => ({ drafts: { ...s.drafts, [back.draftId]: back }, sends: settleSend(s.sends) }));
    }
    /** Change one draft's snapshot list as its next revision, or locally only. */
    function withSnapshots(draftId: string, change: (list: ComposerSnapshot[], d: ComposerDraft) => ComposerSnapshot[] | null, local = false, extra: Partial<ComposerDraft> = {}) {
      const d = get().drafts[draftId];
      if (!d) return;
      const next = change([...draftSnapshots(d)], d);
      if (!next) return;
      put({ ...d, snapshots: next, ...extra, ...(local ? {} : { edit: d.edit + 1, editedAt: now() }) });
    }
    /** The snapshot a send carried, as it stands on its draft. */
    const snapshotOf = (send: DraftSend): { d: ComposerDraft; s: ComposerSnapshot } | null => {
      const d = get().drafts[sendTarget(send)];
      const s = d && draftSnapshots(d).find((x) => x.snapshotId === send.snapshotId);
      return d && s ? { d, s } : null;
    };
    const without = (requestId: string) => (sends: Record<string, DraftSend>) => {
      const next = { ...sends };
      delete next[requestId];
      sendTargets.delete(requestId);
      return next;
    };

    return {
      drafts: {},
      fresh: mintDraftId(),
      sends: {},
      supported: null,
      limits: { ...SESSION_DRAFT_LIMITS },
      fileLimits: null,
      orphans: [],
      snapshotsOn: false,
      outgoingFull: null,

      idFor(sessionId) {
        const state = get();
        if (sessionId === null) return state.fresh;
        const branch = deviceViews.get(sessionId);
        if (branch && state.drafts[resolve(branch)]?.sessionId === null) return resolve(branch);
        if (branch) deviceViews.delete(sessionId);
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
      associateVoice(requested, sessionId, requestId, sourceSessionId) {
        const d = get().drafts[resolve(requested)];
        if (!d || (d.sessionId !== null && d.sessionId !== sessionId && d.sessionId !== sourceSessionId)) return;
        put({ ...d, sessionId, ...(d.host ? { bind: { sessionId, requestId } } : {}) });
      },
      resolveTarget,
      originOf: (draftId) => origins.get(draftId) ?? draftId,
      sendDraftId: requestId => { const send = get().sends[requestId]; return send ? sendTarget(send) : undefined; },

      release() {
        for (const d of Object.values(get().drafts)) release(d.attachments, []);
        // A held send's rows left the transcript: its snapshot alone owns its previews.
        for (const s of Object.values(get().sends)) if (s.state === "unconfirmed") for (const a of s.attachments) revoke(a.previewUrl);
        minted.clear(); transferred.clear(); consumed.clear(); successors.clear(); retired.clear(); origins.clear(); deviceViews.clear(); deviceRedirects.clear(); sendTargets.clear();
      },

      edit(requested, requestedSession, patch) {
        // Late work for a rotated draft, or one forgotten as its session accepted it.
        const { draftId, sessionId } = resolveTarget(requested, requestedSession);
        const current = get().drafts[draftId] ?? blank(draftId, sessionId, now());
        const text = patch.text ?? current.text;
        const attachments = patch.attachments ?? current.attachments;
        const files = patch.files ?? current.files;
        if (text === current.text && attachments === current.attachments && files === current.files) return;
        if (patch.attachments) release(current.attachments, attachments);
        put({ ...current, text, attachments, files, edit: current.edit + 1, editedAt: now(), deviceOnly: patch.deviceOnly === true, failure: current.failure?.kind === "unsaved" ? current.failure : null });
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
        // An explicit Draft choice names an existing retained version, not
        // the continuation alias used by late work from its old composer.
        if (get().drafts[draftId]?.sessionId === null) {
          get().openDeviceVersion(draftId);
          return;
        }
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
          // An emptied draft comes back only while its deletion is owed to the
          // host, or while a lost first save may have left a copy there (#1214).
          if (!hasContent(k) && !(k.host && !k.host.clean) && !k.deviceConflict && !(k.uncertain && !k.host)) continue;
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
            ...blank(k.draftId, k.sessionId, k.editedAt), deviceOnly: k.deviceOnly === true, deviceConflict: k.deviceConflict,
            text: k.text,
            attachments: k.attachments,
            files: k.files ?? [],
            edit,
            // Its images upload again before the next save: the ids they had are not kept.
            // Originals are references the host already holds, so a clean copy lists them.
            host: k.host ? { revision: k.host.revision, edit: k.host.clean ? edit : edit - 1, sessionId: k.host.sessionId, attachmentIds: [], ...(k.files?.length ? { fileIds: k.files.map((f) => f.file.fileId) } : {}), updatedAt: k.host.updatedAt } : null,
            // The draft client's uncertain-save and bind paths pick these up again (#1214).
            uncertain: k.uncertain === true && k.host === null,
            bind: k.bind ?? null,
          });
        }
      },

      keepDeviceBranch(sourceId, branchId, other, sessionId, preserveOther = false) {
        const state = get();
        // Take the live content, including edits made while the transaction
        // was open. Immutable sends keep their original ids and snapshots.
        const followed = follow(sourceId).id;
        // The retained original may itself change while this tab continues
        // another branch. Its direct content is a separate incoming version.
        const liveId = state.drafts[sourceId] ? sourceId : followed;
        const live = state.drafts[liveId] ?? blank(sourceId, sessionId, now());
        const viewSession = live.sessionId ?? sessionId;
        const viewed = viewSession !== null && (state.idFor(viewSession) === liveId || (followed === liveId && !hasContent(state.drafts[state.idFor(viewSession)])));
        const branch: ComposerDraft = { ...live, draftId: branchId, sessionId: null, host: null, uploads: new Map(), bind: null, conflict: null, savingSince: null, uncertain: false, deviceConflict: { otherId: other?.draftId ?? sourceId, sessionId: viewSession } };
        // Navigation redirects can be removed when the reader opens the
        // original. Pending sends keep a separate editable-target binding.
        for (const send of Object.values(state.sends)) if (sendTarget(send) === liveId) sendTargets.set(send.requestId, branchId);
        if (followed === liveId) {
          deviceRedirects.set(sourceId, branchId);
          if (liveId !== sourceId) deviceRedirects.set(liveId, branchId);
        }
        origins.set(branchId, origins.get(sourceId) ?? sourceId);
        // An unbound incoming view keeps its staged queue. The restored
        // original has no files staged in this tab and owns a separate queue.
        if (other?.sessionId === null && (!preserveOther || other.draftId === sourceId || other.draftId === liveId)) origins.set(other.draftId, mintDraftId());
        if (viewSession !== null && viewed) deviceViews.set(viewSession, branchId);
        set(s => {
          const drafts = { ...s.drafts, [branchId]: branch };
          delete drafts[sourceId];
          delete drafts[liveId];
          // A distinct other record can be edited while native commit waits.
          // The caller keeps its prior expectation until those edits save.
          if (other && (!preserveOther || !drafts[other.draftId])) {
            const edit = 1;
            const { uncertain: _uncertain, bind: _bind, ...content } = other;
            drafts[other.draftId] = { ...blank(other.draftId, other.sessionId, other.editedAt), ...content, files: content.files ?? [], edit,
              host: other.host ? { ...other.host, edit: other.host.clean ? edit : -1, attachmentIds: [] } : null };
          }
          return { drafts, fresh: s.fresh === sourceId || s.fresh === liveId ? branchId : s.fresh };
        });
      },
      adoptDeviceRecord(kept) {
        const current = get().drafts[kept.draftId];
        if (current) release(current.attachments, []);
        const edit = 1;
        // Another tab's pending reconciliation stays that tab's to finish.
        const { uncertain: _uncertain, bind: _bind, ...content } = kept;
        const d = { ...blank(kept.draftId, kept.sessionId, kept.editedAt), ...content, files: content.files ?? [], edit, deviceEpoch: (current?.deviceEpoch ?? 0) + 1,
          host: kept.host ? { ...kept.host, edit: kept.host.clean ? edit : -1, attachmentIds: [] } : null };
        set(s => ({ drafts: { ...s.drafts, [kept.draftId]: d } }));
      },
      showDeviceBranch(sessionId, draftId) {
        if (get().drafts[draftId]?.sessionId !== null) return;
        deviceViews.set(sessionId, draftId);
        set(s => ({ drafts: { ...s.drafts } }));
      },
      openDeviceVersion(draftId, kept) {
        if (kept) get().adoptDeviceRecord(kept);
        successors.delete(draftId);
        for (const [source, target] of deviceRedirects) if (source === draftId || target === draftId) deviceRedirects.delete(source);
        for (const [session, branch] of deviceViews) if (branch === draftId || get().drafts[resolve(branch)]?.deviceConflict?.otherId === draftId) deviceViews.delete(session);
        const d = get().drafts[draftId];
        set(s => ({ drafts: { ...s.drafts }, ...(d?.sessionId === null ? { fresh: draftId } : {}) }));
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
          const sentFiles = input.attachmentFiles ?? [];
          const files = draftFiles(d).filter((f) => !sentFiles.some((s) => s.file.fileId === f.file.fileId));
          const text = d.text === consumedText ? "" : d.text;
          put({ ...d, text, attachments: remaining, files, edit: d.edit + 1, editedAt: now(), deviceOnly: false });
        }
        return draftRef;
      },

      sendFailed(requestId) {
        const send = get().sends[requestId];
        if (!send) return;
        const owned = send.snapshotId ? snapshotOf(send) : null;
        if (send.snapshotId) {
          // The frame never left: the snapshot is known unsent, and stays its own message.
          set((st) => ({ sends: without(requestId)(st.sends) }));
          if (owned) withSnapshots(owned.d.draftId, (list) => list.map((x) => x.snapshotId === send.snapshotId
            ? { ...x, state: "returned", dispatch: undefined, why: { kind: "failed", reason: "The connection closed before it was sent." } } : x));
          return;
        }
        giveBack(send, true, without(requestId));
      },

      accepted(requestId, sessionId) {
        const send = get().sends[requestId];
        if (!send || send.state === "accepted" || send.state === "refused") return;
        const acceptedSessionId = sessionId ?? send.sessionId ?? undefined;
        set((s) => ({ sends: { ...s.sends, [requestId]: { ...send, state: "accepted", ...(acceptedSessionId ? { acceptedSessionId } : {}) } } }));
        let d = get().drafts[sendTarget(send)];
        if (!d) return;
        // An unbound draft's first message named a session: the draft is
        // that session's now, whatever view the reader has moved on to.
        const session = d.deviceConflict && send.sessionId !== null ? d.sessionId : d.sessionId ?? acceptedSessionId ?? null;
        if (send.snapshotId || draftSnapshots(d).some((x) => x.requestId === requestId)) {
          // The host released this snapshot with the acceptance, in place and
          // without a revision: it leaves both lists now, so no later save
          // names it again (#3733).
          const release = <T extends { requestId: string }>(list: T[] | undefined) => list?.filter((x) => x.requestId !== requestId);
          const host = d.host ? { ...d.host, ...(d.host.snapshots ? { snapshots: release(d.host.snapshots)! } : {}) } : null;
          const consumedHere = send.draftRef !== null && send.draftRef.draftId === d.draftId && d.host?.revision === send.draftRef.revision;
          d = { ...d, snapshots: release(d.snapshots) ?? [], host };
          if (consumedHere && host && (host.snapshots?.length ?? 0) > 0) {
            // Other snapshots remain: the host keeps the row at the next
            // revision with an empty composer, never a tombstone. What is
            // typed here since is saved over that revision.
            put({
              ...d, sessionId: session, uploads: new Map(),
              host: { ...host, revision: host.revision + 1, edit: -1, attachmentIds: [], ...(host.fileIds ? { fileIds: [] } : {}) },
              ...(d.sessionId === null && session !== null ? { bind: { sessionId: session, requestId } } : {}),
            });
            set((st) => (st.outgoingFull?.draftId === d!.draftId || (session !== null && st.outgoingFull?.sessionId === session) ? { outgoingFull: null } : {}));
            return;
          }
          put(d);
          set((st) => (st.outgoingFull?.draftId === d!.draftId || (session !== null && st.outgoingFull?.sessionId === session) ? { outgoingFull: null } : {}));
        }
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
          if (!hasContent(d) && !held(d.draftId) && !d.deviceConflict) { drop(d.draftId, session); return; }
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


      refused(requestId, reason) {
        const send = get().sends[requestId];
        if (!send || send.state === "accepted" || send.state === "refused") return;
        if (send.snapshotId) {
          // Known not accepted: the snapshot returns, kept as its own message.
          const owned = snapshotOf(send);
          set((st) => ({ sends: { ...st.sends, [requestId]: { ...send, state: "refused" } } }));
          if (owned) withSnapshots(owned.d.draftId, (list) => list.map((x) => x.snapshotId === send.snapshotId
            ? { ...x, state: "returned", dispatch: undefined, why: { kind: "refused", reason: reason ?? "The brain refused this message." } } : x));
          return;
        }
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
        const target = sendTarget(send);
        if (send.sessionId === null) set({ fresh: target });
        else if (get().drafts[target]?.deviceConflict && get().drafts[target]?.sessionId === null) deviceViews.set(send.sessionId, target);
        giveBack(send, true, without(requestId));
      },

      resend(requestId, nextRequestId) {
        const state = get();
        const send = state.sends[requestId];
        if (!send || send.state !== "unconfirmed") return null;
        const d = state.drafts[sendTarget(send)];
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
        sendTargets.set(nextRequestId, sendTarget(send));
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

      setSupport(supported, limits, fileLimits = null, snapshotsOn = false) {
        set({ supported, limits: limits ? { ...limits } : { ...SESSION_DRAFT_LIMITS }, fileLimits: supported && fileLimits ? { ...fileLimits } : null, snapshotsOn: supported && fileLimits !== null && snapshotsOn });
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
        // Snapshots replaced by Send again leave once the host no longer lists them.
        const listed2 = new Set((copy.snapshots ?? []).map((x) => x.snapshotId));
        const snapshots = d.snapshots?.filter((x) => !x.retiring || listed2.has(x.snapshotId));
        put({ ...d, ...(snapshots ? { snapshots } : {}), host: copy, uploads: kept, failure: null, savingSince: null, uncertain: false });
        // This tab freed a slot of the chat: the queue-full notice goes.
        if ((copy.snapshots?.length ?? 0) < (d.host?.snapshots?.length ?? 0)) {
          const full = get().outgoingFull;
          if (full && (full.draftId === draftId || (full.sessionId !== null && full.sessionId === d.sessionId))) set({ outgoingFull: null });
        }
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
          else if (d.deviceConflict) rotate({ ...d, host: null, uploads: new Map(), savingSince: null }, d.sessionId);
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
          else if (d.deviceConflict) rotate({ ...d, host: null, uploads: new Map(), savingSince: null }, d.sessionId);
          else drop(draftId);
          return;
        }
        if (d.host && isClean(d) && !held(draftId)) {
          // Deleted or sent on another device, with nothing new here.
          release(d.attachments, []);
          if (d.deviceConflict) rotate({ ...d, text: "", attachments: [], files: [], host: null, uploads: new Map() }, d.sessionId);
          else drop(draftId);
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
        // Emptied after a first save that got no answer: the draft client
        // settles that copy itself (deleting it, or a conflict on a newer
        // revision), so a host refresh never brings the cleared text back.
        if (!local.host && local.uncertain && !hasContent(local)) return;
        if (local.conflict?.sameId && local.conflict.other.revision >= draft.revision) return;
        // The host holds exactly what is here (a save whose answer was lost):
        // that is an acknowledgement, not another device's version.
        const hostFiles = draft.files ?? [];
        if (local.text === draft.text && local.attachments.length === draft.attachments.length
          && local.attachments.every((a, i) => a.attachment.data === draft.attachments[i]!.bytes)
          && draftFiles(local).length === hostFiles.length && draftFiles(local).every((f, i) => f.lineage === draft.draftId && f.file.fileId === hostFiles[i]!.fileId)
          && JSON.stringify(snapshotSaveList(local).writes) === JSON.stringify((draft.snapshots ?? []).map(({ createdAt: _at, ...w }) => w))) {
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
        put({ ...fromHost(draft), snapshots: mergeSnapshots(local.snapshots, draft.snapshots), deviceConflict: local.deviceConflict, edit: local.edit + 1, host: hostCopy(draft, local.edit + 1) });
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
            put({ ...fromHost(other), snapshots: mergeSnapshots(d.snapshots, other.snapshots), deviceConflict: d.deviceConflict, edit: d.edit + 1, host: hostCopy(other, d.edit + 1) });
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
          // Its originals stay the other draft's lineage: the copy shows them as needing to be chosen again.
          const copy: ComposerDraft = { ...blank(mintDraftId(), null, now()), text: other.text, attachments: other.attachments.map(attachmentFromDraft), files: (other.files ?? []).map((file) => ({ file, lineage: other.draftId })), editedAt: other.updatedAt, edit: 1 };
          put(copy);
          if (!sameId) orphan(other.draftId, other.revision);
        } else if (!sameId) {
          orphan(other.draftId, other.revision);
        }
        const current = get().drafts[draftId]!;
        // Keeping this device's: the next save writes over the host's
        // revision, on purpose. Its images upload again, since the other
        // device's save may have dropped them.
        // The other version's snapshots are never dropped by keeping this
        // one: the host refuses to lose a held or dispatched one.
        const theirs = mergeSnapshots(undefined, other.snapshots).filter((x) => !draftSnapshots(current).some((m) => m.snapshotId === x.snapshotId));
        put(sameId
          ? { ...current, conflict: null, host: otherHost, uploads: new Map(), failure: null, ...(theirs.length ? { snapshots: [...draftSnapshots(current), ...theirs] } : {}) }
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

      createSnapshot(draftId, sessionId, snapshot, consumedText) {
        const d = get().drafts[draftId] ?? blank(draftId, sessionId, now());
        const moved = new Set(snapshot.files.map((f) => f.fileId));
        put({
          ...d, snapshots: [...draftSnapshots(d), snapshot],
          text: d.text === consumedText ? "" : d.text,
          files: draftFiles(d).filter((f) => !moved.has(f.file.fileId)),
          edit: d.edit + 1, editedAt: now(), deviceOnly: false,
        });
      },

      patchSnapshot(draftId, snapshotId, patch, local = false) {
        withSnapshots(draftId, (list) => list.some((x) => x.snapshotId === snapshotId) ? list.map((x) => (x.snapshotId === snapshotId ? { ...x, ...patch } : x)) : null, local);
      },

      snapshotsRefused(draftId, snapshotIds, limit) {
        const d = get().drafts[draftId];
        if (!d) return;
        const refused = draftSnapshots(d).filter((x) => snapshotIds.includes(x.snapshotId));
        if (refused.length === 0) return;
        // Nothing was stored and nothing sent: the text and files go back to
        // the composer, ahead of anything typed since.
        let text = d.text;
        for (const r of [...refused].reverse()) text = text ? (r.text ? `${r.text}\n${text}` : text) : r.text;
        const back = refused.flatMap((r) => r.files.flatMap((f) => f.file ? [{ file: f.file, lineage: draftId }] : []));
        const files = [...back, ...draftFiles(d).filter((f) => !back.some((b) => b.file.fileId === f.file.fileId))];
        put({ ...d, text, files, snapshots: draftSnapshots(d).filter((x) => !snapshotIds.includes(x.snapshotId)), edit: d.edit + 1, editedAt: now() });
        set({ outgoingFull: { draftId, sessionId: d.sessionId, limit } });
      },

      snapshotStored(draftId, snapshotId, itemId, file) {
        withSnapshots(draftId, (list) => list.map((x) => {
          if (x.snapshotId !== snapshotId) return x;
          const uploads = (x.uploads ?? []).filter((id) => id !== itemId);
          // Only a held snapshot's files change: a cancelled one keeps what it had.
          if (x.state !== "held" || x.files.some((f) => f.fileId === file.fileId)) return { ...x, uploads };
          return { ...x, uploads, files: [...x.files, { fileId: file.fileId, file }] };
        }));
      },

      snapshotUploadFailed(draftId, snapshotId, itemId, why) {
        withSnapshots(draftId, (list) => list.map((x) => {
          if (x.snapshotId !== snapshotId) return x;
          if (x.state !== "held") return { ...x, uploads: (x.uploads ?? []).filter((id) => id !== itemId) };
          return { ...x, state: "returned", uploads: [], why, dispatch: undefined };
        }));
      },

      editSnapshot(draftId, snapshotId) {
        const d = get().drafts[draftId];
        const s = d && draftSnapshots(d).find((x) => x.snapshotId === snapshotId);
        if (!d || !s || s.state !== "returned") return false;
        // Never merged: Edit opens only into an empty composer.
        if (d.text.length > 0 || d.attachments.length > 0 || draftFiles(d).length > 0) return false;
        const files = s.files.flatMap((f) => f.file ? [{ file: f.file, lineage: draftId }] : []);
        put({ ...d, text: s.text, files, snapshots: draftSnapshots(d).filter((x) => x.snapshotId !== snapshotId), edit: d.edit + 1, editedAt: now() });
        return true;
      },

      deleteSnapshot(draftId, snapshotId) {
        withSnapshots(draftId, (list) => list.some((x) => x.snapshotId === snapshotId && x.state === "returned") ? list.filter((x) => x.snapshotId !== snapshotId) : null);
      },

      resendSnapshot(draftId, snapshotId, next) {
        withSnapshots(draftId, (list) => {
          const i = list.findIndex((x) => x.snapshotId === snapshotId && x.state === "dispatched" && !x.retiring);
          if (i < 0) return null;
          const old = list[i]!;
          const fresh: ComposerSnapshot = { snapshotId: next.snapshotId, requestId: next.requestId, text: old.text, files: old.files, state: "dispatched", createdAt: null, dispatch: "due", message: next.message, replaces: old.snapshotId };
          // Its successor takes its place in the order; the old one retires.
          return [...list.slice(0, i), { ...old, retiring: true, dispatch: undefined }, fresh, ...list.slice(i + 1)];
        });
      },

      snapshotReleased(draftId, requestId) {
        const d = get().drafts[draftId];
        if (!d) return;
        const release = <T extends { requestId: string }>(list: T[] | undefined) => list?.filter((x) => x.requestId !== requestId);
        put({ ...d, snapshots: release(d.snapshots) ?? [], host: d.host ? { ...d.host, ...(d.host.snapshots ? { snapshots: release(d.host.snapshots)! } : {}) } : null });
        const full = get().outgoingFull;
        if (full && (full.draftId === draftId || (full.sessionId !== null && full.sessionId === d.sessionId))) set({ outgoingFull: null });
      },

      beginSnapshotSend({ unconfirmedAs, ...input }) {
        const send: DraftSend = { ...input, origin: input.origin ?? input.requestId, sentAt: now(), ...(unconfirmedAs ? { state: "unconfirmed", reason: unconfirmedAs } : { state: "pending" }) };
        set((s) => ({ sends: pruneSends({ ...s.sends, [input.requestId]: send }) }));
      },

      clearOutgoingFull() { if (get().outgoingFull) set({ outgoingFull: null }); },

      takeOrphans() {
        const orphans = get().orphans;
        if (orphans.length > 0) set({ orphans: [] });
        return orphans;
      },
    };
  });
}

export type DraftStore = ReturnType<typeof createDraftStore>;
