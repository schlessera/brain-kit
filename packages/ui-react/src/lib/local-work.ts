import { createStore, type StoreApi } from "zustand/vanilla";
import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainStores } from "../stores/create-stores.js";
import { hasContent, type ComposerDraft, type LocalDraft } from "../stores/draft-state.js";
import { mintDraftId } from "./drafts.js";
import type { PendingAttachment } from "./image-attachments.js";
import { PartitionRefusedError, accountPartition, type LocalPartitions, type PartitionHandle, type PartitionWrite } from "./local-partitions.js";

/**
 * The work context, kept on this device in the signed-in account's
 * partition (#1014): every draft's text and images, the voice review text,
 * the uploaded tracks the view holds (by reference), the selection, the
 * focused element and where the transcript was read.
 *
 * It is written a moment after each change, and at once by
 * {@link LocalWork.snapshotNow}, which resolves only after the write has
 * committed. After an authenticated boot as the same account it is put
 * back: the drafts, the review text, the selection and focus, then the
 * transcript's place. Another account restores nothing from it, and this
 * page never writes one account's work into another's partition.
 *
 * Device-local only: never a server save, never on another device, and not
 * protection against someone with access to the device. Staged tracks keep
 * their own lifetime (`tracks in this tab only`, #1112): their references
 * are kept, and a reload does not bring the queue back. An IME composition
 * is not kept; only committed text is.
 */

/** Where the reader was, beyond the drafts themselves. */
export interface WorkContext {
  sessionId: string | null;
  draftId: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  /** The focused element's stable id (see {@link stableFocusId}). */
  focusId: string | null;
  /** The first message in view and how far its top sat from the transcript's top. */
  scroll: { anchor: string; offset: number; fingerprint?: string } | null;
  reviewText: string;
  tracks: SharedFileMeta[];
  /** Uploaded references in inactive staged views, kept for warm reauthentication only. */
  stagedTracks?: Array<{ key: string; tracks: SharedFileMeta[] }>;
}

/** What a view reports at the moment a snapshot is taken. */
export type WorkProbe = () => Partial<Pick<WorkContext, "selectionStart" | "selectionEnd" | "scroll">>;

/** What a restore hands back to the views, each consumed once. */
export interface WorkRestore {
  selection: { draftId: string; start: number; end: number } | null;
  focusId: string | null;
  scroll: { sessionId: string | null; anchor: string; offset: number; fingerprint?: string } | null;
}

export interface LocalWorkStatus {
  /** The last write failed (quota, private mode, no storage): the composer says so. */
  failed: boolean;
  /** Changes not yet committed. */
  pending: boolean;
}

export interface LocalWork {
  status: StoreApi<LocalWorkStatus>;
  restore: StoreApi<WorkRestore>;
  /** Write everything now. Resolves after the transaction commits; rejects when it could not. */
  snapshotNow(): Promise<void>;
  /** @internal Explicitly open the latest retained other version after keeping current edits. */
  openDeviceVersion(draftId: string): Promise<void>;
  /** A view's report of where the reader is; returns its removal. */
  register(probe: WorkProbe): () => void;
  /** @internal Append once, committing the draft and recording receipt together. Never sends. */
  addTranscript(id: string, text: string, draftId: string, sessionId: string | null): Promise<number>;
  /** Something a probe reads changed: write a moment from now. */
  changed(): void;
  /** Resolves once a restore for the held account has finished, if one is under way. */
  restoring(): Promise<void>;
  /** Pause writes and drop the in-memory account payload after the gate unmounts. */
  lock(): void;
  /** @internal Stop scheduling writes and wait for every started write before sign-out clearing. */
  quiesce(): Promise<void>;
  /** Read the saved context only after explicit same-account authentication. */
  resume(): Promise<boolean>;
  dispose(): void;
}

/** A pause after a change before it is written. */
export const LOCAL_WRITE_DELAY_MS = 250;
/** The longest a change waits while changes keep coming. */
export const LOCAL_WRITE_MAX_DELAY_MS = 2_000;

/**
 * What a transcript message says, in short: a replay rebuilds messages with
 * new ids, so the anchor is a place in the transcript checked against this,
 * and a place that now holds another message is looked for by it.
 */
export function messageFingerprint(m: { role: string; content: string }): string {
  let h = 5381;
  const text = m.content.slice(0, 400);
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${m.role}:${text.length}:${h.toString(36)}`;
}

/** The composer's field, by the attribute the kit gives it; else an element's own id. */
export function stableFocusId(el: Element | null): string | null {
  if (!el || el === document.body) return null;
  if (el.matches("textarea[data-composer]")) return "composer";
  const named = el.closest("[data-focus-id]")?.getAttribute("data-focus-id");
  if (named) return `focus:${named}`;
  return el.id ? `id:${el.id}` : null;
}

export function findByFocusId(id: string): HTMLElement | null {
  if (id === "composer") return document.querySelector<HTMLElement>("textarea[data-composer]");
  if (id.startsWith("focus:")) return document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id.slice(6))}"]`);
  if (id.startsWith("id:")) return document.getElementById(id.slice(3));
  return null;
}

type StoredAttachment = { data: string; mediaType: string; bytes: number; name: string };
type StoredDraft = Omit<LocalDraft, "attachments"> & { v: 1; deviceRevision?: number; attachments: StoredAttachment[] };
const draftVersion = (value: unknown): number => (value as StoredDraft | undefined)?.deviceRevision ?? 0;
function serializedDraft(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const { deviceRevision: _revision, ...content } = value as StoredDraft;
  return JSON.stringify(content);
}
const sameContent = (a: StoredDraft, b: StoredDraft): boolean => a.sessionId === b.sessionId && a.text === b.text && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
type StoredContext = WorkContext & { v: 1 };

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);

/** A kept draft, if it is well formed: what comes out of storage is not trusted. */
function parseDraft(raw: unknown): LocalDraft | null {
  const r = raw as Partial<StoredDraft> | null;
  if (!r || r.v !== 1 || !isStr(r.draftId) || !isStrOrNull(r.sessionId ?? null) || !isStr(r.text) || !isNum(r.editedAt) || !Array.isArray(r.attachments)) return null;
  const attachments: PendingAttachment[] = [];
  for (const a of r.attachments) {
    if (!a || !isStr(a.data) || !isStr(a.mediaType) || !a.mediaType.startsWith("image/") || !isNum(a.bytes) || !isStr(a.name)) return null;
    attachments.push({ attachment: { data: a.data, mediaType: a.mediaType as PendingAttachment["attachment"]["mediaType"] }, previewUrl: `data:${a.mediaType};base64,${a.data}`, bytes: a.bytes, name: a.name });
  }
  const h = r.host;
  const host = h && isNum(h.revision) && isStrOrNull(h.sessionId ?? null) && isNum(h.updatedAt) && typeof h.clean === "boolean"
    ? { revision: h.revision, sessionId: h.sessionId ?? null, updatedAt: h.updatedAt, clean: h.clean } : null;
  return { draftId: r.draftId, sessionId: r.sessionId ?? null, text: r.text, attachments, editedAt: r.editedAt, host, deviceOnly: r.deviceOnly === true, ...(r.deviceConflict && isStr(r.deviceConflict.otherId) && isStrOrNull(r.deviceConflict.sessionId) ? { deviceConflict: r.deviceConflict } : {}) };
}

function parseContext(raw: unknown): WorkContext | null {
  const r = raw as Partial<StoredContext> | null;
  if (!r || r.v !== 1 || !isStrOrNull(r.sessionId ?? null) || !isStr(r.draftId) || !isStr(r.reviewText ?? "")) return null;
  const sel = (v: unknown) => (isNum(v) && v >= 0 ? v : null);
  const scroll = r.scroll && isStr(r.scroll.anchor) && isNum(r.scroll.offset)
    ? { anchor: r.scroll.anchor, offset: r.scroll.offset, ...(isStr(r.scroll.fingerprint) ? { fingerprint: r.scroll.fingerprint } : {}) } : null;
  return {
    sessionId: r.sessionId ?? null,
    draftId: r.draftId,
    selectionStart: sel(r.selectionStart),
    selectionEnd: sel(r.selectionEnd),
    focusId: isStr(r.focusId) ? r.focusId : null,
    scroll,
    reviewText: r.reviewText ?? "",
    tracks: Array.isArray(r.tracks) ? r.tracks : [],
    stagedTracks: Array.isArray(r.stagedTracks) ? r.stagedTracks.filter((v) => v && isStr(v.key) && /^(session|draft):.+/.test(v.key) && Array.isArray(v.tracks)) : undefined,
  };
}

function storeDraft(d: ComposerDraft): StoredDraft {
  return {
    v: 1,
    draftId: d.draftId,
    sessionId: d.sessionId,
    text: d.text,
    attachments: d.attachments.map((a) => ({ data: a.attachment.data, mediaType: a.attachment.mediaType, bytes: a.bytes, name: a.name })),
    editedAt: d.editedAt,
    deviceOnly: d.deviceOnly === true,
    ...(d.deviceConflict ? { deviceConflict: d.deviceConflict } : {}),
    host: d.host ? { revision: d.host.revision, sessionId: d.host.sessionId, updatedAt: d.host.updatedAt, clean: d.host.edit === d.edit } : null,
  };
}

export interface LocalWorkOptions {
  stores: BrainStores;
  partitions: LocalPartitions;
  /** This root's records, apart from another root's in the same partition. */
  scope: string;
  /** The current view's track references. */
  tracks: (sessionId: string | null, draftId: string) => SharedFileMeta[];
  /** Calls back on every change to the root's staged tracks. */
  watchTracks: (fn: () => void) => () => void;
  restoreTracks?: (sessionId: string | null, draftId: string, tracks: SharedFileMeta[]) => void;
  allTracks?: () => NonNullable<WorkContext["stagedTracks"]>;
  restoreAllTracks?: (views: NonNullable<WorkContext["stagedTracks"]>) => void;
  /**
   * The client holds another account than the one this page restored for:
   * the first account's drafts are in this page's stores, so the page must
   * not go on under the second. Reloads by default.
   */
  onAccountSwitch?: () => void;
  /** @internal Resume the conversation selected by a cold tab's own context. */
  onSessionRestore?: (sessionId: string) => void;
}

const memoryWriteLocks = new Map<string, Promise<void>>();
async function lockWork(name: string, work: () => Promise<void>): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request(name, work);
    return;
  }
  // Non-browser roots still serialize independent roots in this runtime.
  const previous = memoryWriteLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  const waiting = previous.then(() => done);
  memoryWriteLocks.set(name, waiting);
  await previous;
  try { await work(); }
  finally { release(); if (memoryWriteLocks.get(name) === waiting) memoryWriteLocks.delete(name); }
}

export function createLocalWork(options: LocalWorkOptions): LocalWork {
  const { stores, partitions, scope } = options;
  const draftKey = (id: string) => `${scope}/draft/${id}`;
  const sharedContextKey = `${scope}/context`;
  // The drafts are shared; a tab's selection/branch belongs to that tab.
  let tab: string = crypto.randomUUID();
  try { const key = `brain-ui:work-tab:${scope}`; tab = sessionStorage.getItem(key) ?? tab; sessionStorage.setItem(key, tab); } catch { /* no tab recovery when session storage is unavailable */ }
  let contextKey = `${scope}/context/${tab}`;
  let releaseTab = () => {};
  let tabDisposed = false;
  // Duplicating a tab copies sessionStorage. Hold the identity for this
  // page's lifetime: a simultaneous copy gets a new one, a reload reuses it.
  const tabReady = typeof navigator !== "undefined" && navigator.locks
    ? new Promise<void>(ready => {
      const claim = () => {
        void navigator.locks.request(`brain-ui:work-tab:${scope}:${tab}`, { ifAvailable: true }, lock => {
          if (!lock && !tabDisposed) { tab = crypto.randomUUID(); claim(); return; }
          contextKey = `${scope}/context/${tab}`;
          try { sessionStorage.setItem(`brain-ui:work-tab:${scope}`, tab); } catch { /* editing still works without session storage */ }
          if (tabDisposed) { ready(); return; }
          return new Promise<void>(release => { releaseTab = release; ready(); });
        }).catch(() => ready());
      };
      claim();
    }) : Promise.resolve();
  const status = createStore<LocalWorkStatus>(() => ({ failed: false, pending: false }));
  const restore = createStore<WorkRestore>(() => ({ selection: null, focusId: null, scroll: null }));
  const probes = new Set<WorkProbe>();
  /** The account this page restored for and writes to; another account is never written. */
  let bound: string | null = null;
  let partition: PartitionHandle | null = null;
  let restoreDone: Promise<void> = Promise.resolve();
  /**
   * What the partition holds now, as last committed: each draft id with the
   * object written for it (null when it was read back rather than written
   * here), and the context as text.
   */
  let written = new Map<string, ComposerDraft | null>();
  let committed = new Map<string, string>();
  let versions = new Map<string, number>();
  // A valid session draft skipped during restore is still durable user work.
  // This root must not treat an unadopted conflict as a deliberate deletion.
  const retained = new Map<string, string>();
  let writtenContext = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSince = 0;
  let chain: Promise<void> = Promise.resolve();
  const openingVersions = new Map<string, Promise<void>>();
  let disposed = false;
  let locked = false;
  let generation = 0;
  let revision = 0;
  let committedRevision = 0;
  const receiptKey = (id: string) => `recording:accepted:${id}`;
  // A provisional commit can be redirected only while this root still knows
  // the activation's identity. Reload must not guess a lost session owner.
  const pendingAcceptances = new Map<string, { draftId: string; sessionId: string | null }>();
  const finalizing = new Set<AbortController>();
  type Acceptance = { id: string; draft: ComposerDraft; textHash: string; finalized?: boolean; signal?: AbortSignal };

  const held = () => stores.connection.getState().accountKey;
  let switching = false;
  function switchAccount() {
    if (switching || disposed) return;
    switching = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    (options.onAccountSwitch ?? (() => { if (typeof location !== "undefined") location.reload(); }))();
  }

  function context(): WorkContext {
    const sessionId = stores.chat.getState().activeSessionId;
    const drafts = stores.drafts.getState();
    const draftId = drafts.idFor(sessionId);
    const ctx: WorkContext = {
      sessionId, draftId, selectionStart: null, selectionEnd: null,
      focusId: typeof document === "undefined" ? null : stableFocusId(document.activeElement),
      scroll: null,
      reviewText: stores.voice.getState().reviewText,
      tracks: options.tracks(sessionId, drafts.originOf(draftId)),
      stagedTracks: options.allTracks?.(),
    };
    for (const probe of probes) Object.assign(ctx, probe());
    return ctx;
  }

  /** One write of everything that changed since the last commit. */
  async function flush(acceptance?: Acceptance): Promise<void> {
    const writingGeneration = generation;
    const writingAccount = bound;
    try { await lockWork(`brain-ui:work:${writingAccount}:${scope}`, () => {
      if (writingGeneration !== generation || (acceptance && locked)) throw new PartitionRefusedError(accountPartition(writingAccount ?? ""));
      return flushLocked(acceptance);
    }); }
    catch (error) {
      if (!(error instanceof PartitionRefusedError)) status.setState({ failed: true, pending: false });
      throw error;
    }
  }
  async function flushLocked(acceptance?: Acceptance): Promise<void> {
    // A snapshot asked for and then cancelled by the root going is not a receipt.
    if (disposed) throw new Error("The work context was disposed before it was written");
    if (locked || bound === null || partition === null) {
      if (acceptance) throw new PartitionRefusedError(accountPartition(bound ?? ""));
      return;
    }
    if (held() !== bound) throw new PartitionRefusedError(accountPartition(bound));
    const writingRevision = revision;
    const writingGeneration = generation;
    const writingAccount = bound;
    const writingPartition = partition;
    const checkGeneration = () => {
      if (disposed || locked || writingGeneration !== generation) throw new PartitionRefusedError(accountPartition(writingAccount));
    };
    const drafts = { ...stores.drafts.getState().drafts };
    if (acceptance) drafts[acceptance.draft.draftId] = acceptance.draft;
    const changes: PartitionWrite[] = acceptance ? [{ put: receiptKey(acceptance.id), value: { draftId: acceptance.draft.draftId, revision: acceptance.draft.edit, textHash: acceptance.textHash, finalized: acceptance.finalized === true } }] : [];
    const next = new Map<string, ComposerDraft | null>();
    const nextCommitted = new Map<string, string>();
    for (const d of Object.values(drafts)) {
      // An emptied draft the host still holds is kept too: its deletion is still owed.
      if (!hasContent(d) && d.host === null && !d.deviceConflict) continue;
      next.set(d.draftId, d);
      const value = storeDraft(d);
      const serialized = JSON.stringify(value);
      nextCommitted.set(d.draftId, serialized);
      if (committed.get(d.draftId) !== serialized || acceptance?.draft.draftId === d.draftId) changes.push({ put: draftKey(d.draftId), value });
    }
    for (const [id, serialized] of retained) if (!next.has(id)) {
      next.set(id, null);
      nextCommitted.set(id, serialized);
    }
    for (const id of written.keys()) if (!next.has(id)) {
      const baseline = committed.get(id);
      const saved = baseline ? parseDraft(JSON.parse(baseline)) : null;
      if (saved && !saved.text && !saved.attachments.length && !saved.host) { next.set(id, null); nextCommitted.set(id, baseline!); }
      else changes.push({ delete: draftKey(id) });
    }
    const ctx = context();
    const text = JSON.stringify(ctx);
    // Draft mutations may need to retarget an otherwise unchanged context
    // inside this native transaction, before any later snapshot can run.
    if (text !== writtenContext || changes.length > 0) {
      const value = { v: 1, ...ctx } satisfies StoredContext;
      changes.push({ put: contextKey, value }, { put: sharedContextKey, value });
    }
    if (changes.length === 0) { committedRevision = writingRevision; status.setState({ pending: false }); return; }
    type Fork = { source: string; branch: string; sessionId: string | null; other: LocalDraft | null };
    let forks: Fork[] = [];
    const nextVersions = new Map(versions);
    try {
      forks = await writingPartition.mutate(`${scope}/draft/`, stored => {
        checkGeneration();
        const actual = new Map(stored.map(r => [r.key, r.value as StoredDraft]));
        const planned: PartitionWrite[] = [];
        const result: Fork[] = [];
        const staleRecord = (id: string, saved: StoredDraft | undefined) => draftVersion(saved) !== (versions.get(id) ?? 0) || serializedDraft(saved) !== committed.get(id);
        const removals = new Set<string>();
        const predecessors = new Map<string, { id: string; saved: StoredDraft }>();
        for (const c of changes) if ("delete" in c && c.delete.startsWith(`${scope}/draft/`)) {
          const id = c.delete.slice(`${scope}/draft/`.length);
          const saved = actual.get(c.delete);
          if (!staleRecord(id, saved)) removals.add(c.delete);
          else if (saved && (saved.text.length || saved.attachments.length || saved.host)) {
            const successor = stores.drafts.getState().resolveId(id);
            if (successor !== id && changes.some(change => "put" in change && change.put === draftKey(successor))) predecessors.set(successor, { id, saved });
          }
        }
        for (const change of changes) {
          const key = "put" in change ? change.put : change.delete;
          if (!key.startsWith(`${scope}/draft/`)) { planned.push(change); continue; }
          const id = key.slice(`${scope}/draft/`.length);
          const saved = actual.get(key);
          const incoming = "put" in change ? change.value as StoredDraft : null;
          const stale = staleRecord(id, saved);
          // A rotated writer's successor carries its incoming version. Keep
          // the stale predecessor without creating a second empty branch.
          if (!incoming && [...predecessors.values()].some(p => p.id === id)) {
            next.set(id, null); nextCommitted.set(id, serializedDraft(saved)!); nextVersions.set(id, draftVersion(saved));
            continue;
          }
          const predecessor = predecessors.get(id);
          const collision = (!saved || saved.sessionId !== incoming?.sessionId) && incoming?.sessionId !== null && incoming?.sessionId !== undefined
            ? [...actual].find(([k,v]) => v.sessionId === incoming.sessionId && (v.text.length > 0 || v.attachments.length > 0 || v.host !== null) && k !== key && !removals.has(k)) : undefined;
          if ((stale && (!incoming || !saved || !sameContent(incoming, saved))) || collision || predecessor) {
            // A divergent write never replaces the already-committed owner.
            // Branch content, context and any acceptance receipt co-commit.
            const other = predecessor?.saved ?? collision?.[1] ?? saved;
            const branch = mintDraftId();
            const source = incoming ?? { v: 1 as const, draftId: id, sessionId: drafts[id]?.sessionId ?? parseDraft(saved)?.sessionId ?? null, text: "", attachments: [], editedAt: Date.now(), host: null };
            const viewSession = source.sessionId ?? predecessor?.saved.sessionId ?? null;
            const value: StoredDraft = { ...source, draftId: branch, sessionId: null, host: null, deviceRevision: 1, deviceConflict: { otherId: other?.draftId ?? id, sessionId: viewSession } };
            planned.push({ put: draftKey(branch), value });
            result.push({ source: id, branch, sessionId: viewSession, other: other ? parseDraft(other) : null });
            next.delete(id); nextCommitted.delete(id); nextVersions.delete(id);
            if (saved) { next.set(id, null); nextCommitted.set(id, serializedDraft(saved)!); nextVersions.set(id, draftVersion(saved)); }
            if (other) { next.set(other.draftId, null); nextCommitted.set(other.draftId, serializedDraft(other)!); nextVersions.set(other.draftId, draftVersion(other)); }
            next.set(branch, null); nextCommitted.set(branch, serializedDraft(value)!); nextVersions.set(branch, 1);
            // Update the planned context and receipt without changing navigation.
            for (const c of changes) if ("put" in c) {
              if ((c.put === contextKey || c.put === sharedContextKey) && ((c.value as StoredContext).draftId === id || (predecessor && (c.value as StoredContext).sessionId === viewSession && !drafts[(c.value as StoredContext).draftId]))) c.value = { ...c.value as StoredContext, draftId: branch };
              if (c.put === (acceptance ? receiptKey(acceptance.id) : "") && (c.value as {draftId:string}).draftId === id) c.value = { ...c.value as object, draftId: branch };
            }
            continue;
          }
          if (incoming) {
            const value = { ...incoming, deviceRevision: draftVersion(saved) + 1 };
            planned.push({ put: key, value }); actual.set(key, value); nextVersions.set(id, value.deviceRevision);
          } else {
            // Keep an empty revision tombstone. A stale write after deletion
            // must branch rather than reuse the deleted identity's revision.
            if (saved) {
              const value: StoredDraft = { ...saved, text: "", attachments: [], host: null, deviceConflict: undefined, deviceRevision: draftVersion(saved) + 1 };
              planned.push({ put: key, value }); actual.set(key, value);
              next.set(id, null); nextCommitted.set(id, serializedDraft(value)!); nextVersions.set(id, value.deviceRevision!);
            }
          }
        }
        return { changes: planned, result };
      }, acceptance?.signal);
    } catch (error) {
      // No branch association or kept notice can precede native commit.
      if (!(error instanceof PartitionRefusedError)) status.setState({ failed: true, pending: false });
      throw error;
    }
    checkGeneration();
    committedRevision = writingRevision;
    written = next;
    committed = nextCommitted;
    versions = nextVersions;
    // Association changes use the live draft, so typing during commit is
    // still visible. Their next snapshot updates the same retained branch.
    for (const fork of forks) stores.drafts.getState().keepDeviceBranch(fork.source, fork.branch, fork.other, fork.sessionId);
    writtenContext = forks.length ? "" : text;
    status.setState({ failed: false, pending: timer !== null });
  }

  function enqueue(): Promise<void> {
    const run = chain.then(() => flush());
    // The chain goes on after a failure; the caller of this run still sees it.
    chain = run.catch(() => {});
    return run;
  }

  function changed() {
    if (disposed || locked || bound === null) return;
    revision++;
    const now = Date.now();
    // Steady typing moves the write on, but never past the longest wait.
    if (timer !== null && now - pendingSince >= LOCAL_WRITE_MAX_DELAY_MS - LOCAL_WRITE_DELAY_MS) return;
    if (timer !== null) clearTimeout(timer);
    else pendingSince = now;
    status.setState({ pending: true });
    timer = setTimeout(() => {
      timer = null;
      void enqueue().catch(() => {});
    }, LOCAL_WRITE_DELAY_MS);
  }

  async function bind(key: string, warm = false): Promise<boolean> {
    const binding = generation;
    const initialSession = stores.chat.getState().activeSessionId;
    await tabReady;
    if (disposed || held() !== key || binding !== generation) return false;
    const handle = partitions.open(accountPartition(key));
    const records = await handle.list(`${scope}/`);
    if (disposed || held() !== key || binding !== generation) return false;
    const kept: LocalDraft[] = [];
    let ctx: WorkContext | null = null;
    for (const { key: k, value } of records) {
      if (k === contextKey) ctx = parseContext(value);
      else if (k.startsWith(`${scope}/draft/`)) { const d = parseDraft(value); if (d) kept.push(d); }
    }
    const ownContext = ctx !== null;
    if (!ctx) ctx = parseContext(records.find(r => r.key === sharedContextKey)?.value);
    // Shared navigation is only a fallback. A cold tab resumes its own
    // committed view unless the reader already navigated or started typing.
    let restoredSession = false;
    if (ctx && (warm || (ownContext && stores.chat.getState().activeSessionId === initialSession &&
      !Object.values(stores.drafts.getState().drafts).some(hasContent)))) {
      restoredSession = !warm && ctx.sessionId !== initialSession;
      stores.chat.getState().setActiveSession(ctx.sessionId);
    }
    stores.drafts.getState().restoreLocal(kept);
    if (warm && ctx?.stagedTracks) options.restoreAllTracks?.(ctx.stagedTracks);
    const drafts = stores.drafts.getState();
    // Track each stored baseline. A draft this root adopts may be replaced
    // or removed; a valid conflicting session draft remains untouched.
    for (const { key: k, value } of records) if (k.startsWith(`${scope}/draft/`)) {
      const id = k.slice(`${scope}/draft/`.length);
      written.set(id, null);
      committed.set(id, serializedDraft(value)!);
      versions.set(id, draftVersion(value));
      const saved = parseDraft(value);
      if (saved && saved.sessionId !== null && !drafts.drafts[id] &&
        (saved.text.length > 0 || saved.attachments.length > 0)) retained.set(id, serializedDraft(value)!);
    }
    if (ctx) {
      const activeSession = stores.chat.getState().activeSessionId;
      if (ctx.sessionId === activeSession) {
        // A new chat's own draft goes back into the new-chat view.
        // Not over a new chat the reader has already started typing in.
        if (ctx.sessionId === null && (drafts.drafts[ctx.draftId] || (warm && ctx.tracks.length)) && !hasContent(drafts.drafts[drafts.fresh])) drafts.openUnbound(ctx.draftId);
        if (activeSession !== null && drafts.drafts[ctx.draftId]?.sessionId === null && drafts.drafts[ctx.draftId]?.deviceConflict) drafts.showDeviceBranch(activeSession, ctx.draftId);
        const draftId = stores.drafts.getState().idFor(activeSession);
        // The selection is the kept draft's: a draft this page holds instead keeps its own.
        const same = stores.drafts.getState().resolveId(ctx.draftId) === draftId;
        if (warm && !ctx.stagedTracks) options.restoreTracks?.(ctx.sessionId, drafts.originOf(ctx.draftId), ctx.tracks);
        restore.setState({
          selection: same && ctx.selectionStart !== null && ctx.selectionEnd !== null ? { draftId, start: ctx.selectionStart, end: ctx.selectionEnd } : null,
          focusId: same || ctx.focusId !== "composer" ? ctx.focusId : null,
          scroll: ctx.scroll ? { sessionId: ctx.sessionId, ...ctx.scroll } : null,
        });
        // The composer refocuses its own field with the selection; anything
        // else is focused once it has mounted, if it does within a moment.
        if (ctx.focusId && ctx.focusId !== "composer" && typeof requestAnimationFrame !== "undefined") {
          const id = ctx.focusId;
          const until = Date.now() + 1_000;
          const attempt = () => {
            if (disposed || restore.getState().focusId !== id) return;
            const el = findByFocusId(id);
            if (el) { el.focus({ preventScroll: true }); restore.setState({ focusId: null }); return; }
            if (Date.now() < until) requestAnimationFrame(attempt);
            else restore.setState({ focusId: null });
          };
          requestAnimationFrame(attempt);
        }
      }
      if (ctx.reviewText && !stores.voice.getState().reviewText) stores.voice.getState().setReviewText(ctx.reviewText);
    }
    partition = handle;
    bound = key;
    if (restoredSession && ctx?.sessionId !== null && ctx?.sessionId !== undefined) options.onSessionRestore?.(ctx.sessionId);
    // Anything that changed while the restore was out is written now.
    changed();
    return ctx !== null;
  }

  function onAccount() {
    const key = held();
    // The first account this page holds is the one it restores for; it never rebinds to another.
    if (locked || key === null || bound !== null || disposed) return;
    restoreDone = bind(key).then(() => {}).catch(() => {
      // Unreadable storage restores nothing; editing goes on, and writes report their own failure.
      if (!disposed && held() === key) { partition = partitions.open(accountPartition(key)); bound = key; }
    });
  }

  const unsubscribers = [
    stores.connection.subscribe((s, prev) => {
      // Another account while this page holds the first one's work: the page
      // starts again, as a sign-in as another account does (#578 §1).
      if (s.accountKey !== null && bound !== null && s.accountKey !== bound) { switchAccount(); return; }
      if (s.accountKey !== prev.accountKey) onAccount();
      // The same account again, after a refusal: what waited is written.
      if (s.accountKey !== null && s.accountKey === bound && prev.accountKey !== bound) changed();
    }),
    stores.drafts.subscribe((s, prev) => { if (s.drafts !== prev.drafts || s.fresh !== prev.fresh) changed(); }),
    stores.voice.subscribe((s, prev) => { if (s.reviewText !== prev.reviewText) changed(); }),
    stores.chat.subscribe((s, prev) => { if (s.activeSessionId !== prev.activeSessionId) changed(); }),
    options.watchTracks(changed),
  ];
  const onDom = () => changed();
  if (typeof document !== "undefined") {
    document.addEventListener("selectionchange", onDom);
    document.addEventListener("focusin", onDom);
  }
  onAccount();

  return {
    status,
    restore,
    async snapshotNow() {
      if (bound === null) throw new PartitionRefusedError("account:");
      // Changes made while a transaction commits belong to this snapshot too.
      // The final iteration and the caller's unmount run in one microtask turn.
      do {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        await enqueue();
        if (locked || bound === null) throw new PartitionRefusedError("account:");
      } while (committedRevision !== revision);
    },
    openDeviceVersion(draftId) {
      const pending = openingVersions.get(draftId);
      if (pending) return pending;
      const open = async () => {
        await this.snapshotNow();
        const readingGeneration = generation;
        const handle = partition;
        if (!handle) throw new PartitionRefusedError("account:");
        const before = stores.drafts.getState().drafts[draftId];
        const raw = await handle.get(draftKey(draftId));
        if (locked || disposed || readingGeneration !== generation) throw new PartitionRefusedError(handle.id);
        // A late read cannot replace text/images edited while it was out,
        // nor advance that writer's expected baseline past unseen changes.
        const unchanged = stores.drafts.getState().drafts[draftId] === before;
        const saved = unchanged ? parseDraft(raw) : null;
        if (saved) {
          written.set(draftId, null);
          committed.set(draftId, serializedDraft(raw)!);
          versions.set(draftId, draftVersion(raw));
        }
        stores.drafts.getState().openDeviceVersion(draftId, saved ?? undefined);
      };
      const operation = open().finally(() => { openingVersions.delete(draftId); });
      openingVersions.set(draftId, operation);
      return operation;
    },
    addTranscript(id, text, draftId, sessionId) {
      const account = held();
      const acceptanceGeneration = generation;
      const run = chain.then(async () => {
        if (account === null || account !== bound || held() !== account || !partition || disposed || locked || acceptanceGeneration !== generation) throw new PartitionRefusedError(accountPartition(account ?? ""));
        const textHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");
        if (locked || acceptanceGeneration !== generation || held() !== account) throw new PartitionRefusedError(accountPartition(account));
        const receipt = await partition.get(receiptKey(id)) as { revision: number; textHash: string; finalized?: boolean } | undefined;
        if (held() !== account || locked || acceptanceGeneration !== generation) throw new PartitionRefusedError(accountPartition(account));
        if (receipt?.textHash !== undefined && receipt.textHash !== textHash) throw new Error("This recording was already added with a different transcript");
        if (receipt?.finalized === true) return receipt.revision;
        let activation = pendingAcceptances.get(id);
        if (receipt && !activation) throw new Error("The accepted draft's owner could not be recovered. The recording is kept.");
        if (!receipt) {
          const state = stores.drafts.getState();
          const { draftId: target, sessionId: owner } = state.resolveTarget(draftId, sessionId);
          const current = state.drafts[target];
          const before = current?.text ?? "";
          const base: ComposerDraft = current ?? {
            draftId: target, sessionId: owner, text: "", attachments: [], editedAt: Date.now(), edit: 0, host: null,
            uploads: new Map(), failure: null, savingSince: null, conflict: null, uncertain: false, bind: null,
          };
          const draft: ComposerDraft = { ...base, text: before ? `${before}\n${text}` : text, edit: base.edit + 1, deviceOnly: true };
          await flush({ id, draft, textHash });
          if (locked || acceptanceGeneration !== generation) throw new PartitionRefusedError(accountPartition(account));
          activation = { draftId: target, sessionId: owner };
          pendingAcceptances.set(id, activation);
          if (!disposed) {
            const latest = stores.drafts.getState();
            const liveText = latest.drafts[latest.resolveId(target)]?.text ?? "";
            latest.edit(target, owner, { text: liveText ? `${liveText}\n${text}` : text, deviceOnly: true });
          }
        }
        let keptDraft: ComposerDraft;
        for (;;) {
          if (held() !== account || disposed || locked || acceptanceGeneration !== generation) throw new PartitionRefusedError(accountPartition(account));
          const latest = stores.drafts.getState();
          const resolved = latest.resolveTarget(activation!.draftId, activation!.sessionId);
          const candidate = latest.drafts[resolved.draftId];
          if (!candidate || !candidate.text.includes(text)) throw new Error("The draft changed before its accepted transcript was saved");
          const controller = new AbortController();
          finalizing.add(controller);
          const guard = () => {
            const now = stores.drafts.getState().resolveTarget(activation!.draftId, activation!.sessionId);
            if (now.draftId !== resolved.draftId || now.sessionId !== resolved.sessionId) controller.abort();
          };
          const unwatch = stores.drafts.subscribe(guard);
          try {
            // Co-commit the stable owner and the cleanup permission. If its
            // identity rotates inside native IndexedDB, abort that transaction.
            await flush({ id, draft: candidate, textHash, finalized: true, signal: controller.signal });
            keptDraft = candidate;
            break;
          } catch (error) {
            if (!controller.signal.aborted || disposed || locked || acceptanceGeneration !== generation) throw error;
          } finally { unwatch(); finalizing.delete(controller); }
        }
        pendingAcceptances.delete(id);
        if (held() !== account || disposed || locked || acceptanceGeneration !== generation) throw new PartitionRefusedError(accountPartition(account));
        return keptDraft.edit;
      });
      chain = run.then(() => {}, () => {});
      return run;
    },
    register(probe) {
      probes.add(probe);
      return () => { probes.delete(probe); };
    },
    changed,
    restoring: () => restoreDone,
    lock() {
      generation++;
      for (const controller of finalizing) controller.abort();
      pendingAcceptances.clear();
      locked = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      bound = null; partition = null; written.clear(); committed.clear(); versions.clear(); retained.clear(); writtenContext = "";
      restore.setState({ selection: null, focusId: null, scroll: null });
      status.setState({ pending: false });
    },
    async quiesce() {
      this.lock();
      await chain;
      await restoreDone;
    },
    async resume() {
      const key = held();
      if (!key || disposed) return false;
      try {
        const restored = await bind(key, true);
        if (restored) { locked = false; changed(); }
        return restored;
      } catch { return false; }
    },
    dispose() {
      disposed = true;
      tabDisposed = true; releaseTab();
      for (const controller of finalizing) controller.abort();
      pendingAcceptances.clear();
      if (timer !== null) clearTimeout(timer);
      for (const off of unsubscribers) off();
      if (typeof document !== "undefined") {
        document.removeEventListener("selectionchange", onDom);
        document.removeEventListener("focusin", onDom);
      }
    },
  };
}
