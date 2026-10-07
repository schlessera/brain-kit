import { createStore, type StoreApi } from "zustand/vanilla";
import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainStores } from "../stores/create-stores.js";
import { hasContent, type ComposerDraft, type LocalDraft } from "../stores/draft-state.js";
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
  /** A view's report of where the reader is; returns its removal. */
  register(probe: WorkProbe): () => void;
  /** Something a probe reads changed: write a moment from now. */
  changed(): void;
  /** Resolves once a restore for the held account has finished, if one is under way. */
  restoring(): Promise<void>;
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
type StoredDraft = Omit<LocalDraft, "attachments"> & { v: 1; attachments: StoredAttachment[] };
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
  return { draftId: r.draftId, sessionId: r.sessionId ?? null, text: r.text, attachments, editedAt: r.editedAt, host };
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
  /**
   * The client holds another account than the one this page restored for:
   * the first account's drafts are in this page's stores, so the page must
   * not go on under the second. Reloads by default.
   */
  onAccountSwitch?: () => void;
}

export function createLocalWork(options: LocalWorkOptions): LocalWork {
  const { stores, partitions, scope } = options;
  const draftKey = (id: string) => `${scope}/draft/${id}`;
  const contextKey = `${scope}/context`;
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
  let writtenContext = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSince = 0;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

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
    };
    for (const probe of probes) Object.assign(ctx, probe());
    return ctx;
  }

  /** One write of everything that changed since the last commit. */
  async function flush(): Promise<void> {
    // A snapshot asked for and then cancelled by the root going is not a receipt.
    if (disposed) throw new Error("The work context was disposed before it was written");
    if (bound === null || partition === null) return;
    if (held() !== bound) throw new PartitionRefusedError(accountPartition(bound));
    const drafts = stores.drafts.getState().drafts;
    const changes: PartitionWrite[] = [];
    const next = new Map<string, ComposerDraft | null>();
    for (const d of Object.values(drafts)) {
      // An emptied draft the host still holds is kept too: its deletion is still owed.
      if (!hasContent(d) && d.host === null) continue;
      next.set(d.draftId, d);
      if (written.get(d.draftId) !== d) changes.push({ put: draftKey(d.draftId), value: storeDraft(d) });
    }
    for (const id of written.keys()) if (!next.has(id)) changes.push({ delete: draftKey(id) });
    const ctx = context();
    const text = JSON.stringify(ctx);
    if (text !== writtenContext) changes.push({ put: contextKey, value: { v: 1, ...ctx } satisfies StoredContext });
    if (changes.length === 0) { status.setState({ pending: false }); return; }
    try {
      await partition.write(changes);
    } catch (error) {
      // Nothing is reported as kept; editing goes on in memory, and the next change tries again.
      if (!(error instanceof PartitionRefusedError)) status.setState({ failed: true, pending: false });
      throw error;
    }
    written = next;
    writtenContext = text;
    status.setState({ failed: false, pending: timer !== null });
  }

  function enqueue(): Promise<void> {
    const run = chain.then(flush);
    // The chain goes on after a failure; the caller of this run still sees it.
    chain = run.catch(() => {});
    return run;
  }

  function changed() {
    if (disposed || bound === null) return;
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

  async function bind(key: string) {
    const handle = partitions.open(accountPartition(key));
    const records = await handle.list(`${scope}/`);
    if (disposed || held() !== key) return;
    const kept: LocalDraft[] = [];
    let ctx: WorkContext | null = null;
    for (const { key: k, value } of records) {
      if (k === contextKey) ctx = parseContext(value);
      else if (k.startsWith(`${scope}/draft/`)) { const d = parseDraft(value); if (d) kept.push(d); }
    }
    stores.drafts.getState().restoreLocal(kept);
    const drafts = stores.drafts.getState();
    // These are in storage now. The next write puts back each one this page
    // holds and deletes the rest, which a newer draft here replaced.
    for (const { key: k } of records) if (k.startsWith(`${scope}/draft/`)) written.set(k.slice(`${scope}/draft/`.length), null);
    if (ctx) {
      const activeSession = stores.chat.getState().activeSessionId;
      if (ctx.sessionId === activeSession) {
        // A new chat's own draft goes back into the new-chat view.
        // Not over a new chat the reader has already started typing in.
        if (ctx.sessionId === null && drafts.drafts[ctx.draftId] && !hasContent(drafts.drafts[drafts.fresh])) drafts.openUnbound(ctx.draftId);
        const draftId = stores.drafts.getState().idFor(activeSession);
        restore.setState({
          selection: ctx.selectionStart !== null && ctx.selectionEnd !== null ? { draftId, start: ctx.selectionStart, end: ctx.selectionEnd } : null,
          focusId: ctx.focusId,
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
    // Anything that changed while the restore was out is written now.
    changed();
  }

  function onAccount() {
    const key = held();
    // The first account this page holds is the one it restores for; it never rebinds to another.
    if (key === null || bound !== null || disposed) return;
    restoreDone = bind(key).catch(() => {
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
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (bound === null) throw new PartitionRefusedError("account:");
      await enqueue();
    },
    register(probe) {
      probes.add(probe);
      return () => { probes.delete(probe); };
    },
    changed,
    restoring: () => restoreDone,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      for (const off of unsubscribers) off();
      if (typeof document !== "undefined") {
        document.removeEventListener("selectionchange", onDom);
        document.removeEventListener("focusin", onDom);
      }
    },
  };
}
