import type { AttachmentFile } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { apiBaseFor } from "./backend.js";
import { createAttachmentQueue, queuedPending, type AttachmentQueue, type QueuedFile } from "./attachment-queue.js";
import { disposeFrames, ensureFrame } from "./image-frames.js";

/**
 * One root's generic upload queues, per composer view (#3155).
 *
 * A queue holds only files the host has not stored yet. A stored original
 * goes straight into its draft (`ComposerDraft.files`), whose saved
 * revision then binds it on the host; that, not the upload, is what can
 * read as saved. What is still in a queue lives in this page only, so a
 * reload or closing the tab while any queue holds a file asks the browser
 * to confirm, as staged tracks do (#1150).
 *
 * Keyed as `trackKey` keys tracks: a session's view by its session id, so
 * its queue survives the draft id rotating under it; the new-chat view by
 * its draft's first id.
 */
type Entry = { queue: AttachmentQueue; listeners: Set<() => void>; sessionId?: string | null };
type Registry = { entries: Map<string, Entry>; leaving: ((event: BeforeUnloadEvent) => void) | null; watchers: Set<() => void> };

const registries = new WeakMap<object, Registry>();

function registry(root: BrainUiServices): Registry {
  let reg = registries.get(root.stores);
  if (!reg) { reg = { entries: new Map(), leaving: null, watchers: new Set() }; registries.set(root.stores, reg); }
  return reg;
}

function guardLeaving(reg: Registry) {
  if (typeof window === "undefined") return;
  const queued = [...reg.entries.values()].some((entry) => entry.queue.files.length > 0);
  if (queued && !reg.leaving) {
    reg.leaving = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", reg.leaving);
  } else if (!queued && reg.leaving) {
    window.removeEventListener("beforeunload", reg.leaving);
    reg.leaving = null;
  }
}

/**
 * The stored original joins its draft, or the held snapshot it belongs to:
 * the next save binds it. An image's frame is then made from the very bytes
 * that were uploaded.
 */
function storedInto(root: BrainUiServices, sessionId: string | null, item: QueuedFile, file: AttachmentFile) {
  const draftId = item.draftId;
  const drafts = root.stores.drafts.getState();
  if (item.snapshotId) {
    drafts.snapshotStored(drafts.resolveId(draftId), item.snapshotId, item.id, file);
  } else {
    const { draftId: target } = drafts.resolveTarget(draftId, sessionId);
    const current = drafts.drafts[target]?.files ?? [];
    if (!current.some((f) => f.file.fileId === file.fileId)) drafts.edit(draftId, sessionId, { files: [...current, { file, lineage: draftId }] });
  }
  ensureFrame(root, file, item.file);
}

export function filesFor(root: BrainUiServices, key: string, sessionId: string | null): Entry {
  const reg = registry(root);
  let entry = reg.entries.get(key);
  if (!entry) {
    const listeners = new Set<() => void>();
    const created: Entry = {
      queue: createAttachmentQueue({
        request: root.request,
        apiBase: apiBaseFor(root.config),
        resolveDraft: (draftId) => root.stores.drafts.getState().resolveId(draftId),
        stored: (item, file) => storedInto(root, sessionId, item, file),
        // A held snapshot's upload that was not stored returns that message (rev 5 §2).
        settled: (item) => {
          if (!item.snapshotId) return false;
          const drafts = root.stores.drafts.getState();
          drafts.snapshotUploadFailed(drafts.resolveId(item.draftId), item.snapshotId, item.id,
            { kind: item.state === "refused" ? "refused" : "failed", file: item.name, reason: item.detail ?? item.status ?? "upload failed" });
          return true;
        },
        changed: () => { for (const l of listeners) l(); guardLeaving(reg); for (const w of reg.watchers) w(); },
      }),
      listeners,
      sessionId,
    };
    entry = created;
    reg.entries.set(key, entry);
  }
  return entry;
}

/** Calls back on every change to any of the root's upload queues (#3155). */
export function subscribeAllFiles(root: BrainUiServices, fn: () => void): () => void {
  const reg = registry(root);
  reg.watchers.add(fn);
  return () => { reg.watchers.delete(fn); };
}

/**
 * The composer files still uploading, by the draft they are for (#3155):
 * names only. A held snapshot's uploads are that message's, and a failed
 * or refused file is not uploading.
 */
export function uploadingNames(root: BrainUiServices): Array<{ draftId: string; sessionId: string | null; names: string[] }> {
  const reg = registries.get(root.stores);
  if (!reg) return [];
  const drafts = root.stores.drafts.getState();
  const byDraft = new Map<string, { sessionId: string | null; names: string[] }>();
  for (const entry of reg.entries.values()) {
    for (const item of entry.queue.files) {
      if (item.snapshotId || !queuedPending(item)) continue;
      const id = drafts.resolveId(item.draftId);
      const view = byDraft.get(id) ?? { sessionId: drafts.drafts[id]?.sessionId ?? entry.sessionId ?? null, names: [] };
      view.names.push(item.name);
      byDraft.set(id, view);
    }
  }
  return [...byDraft].map(([draftId, view]) => ({ draftId, ...view }));
}

/** The root is going: every upload is aborted, and none starts another. */
export function disposeFiles(root: BrainUiServices): void {
  disposeFrames(root);
  const reg = registries.get(root.stores);
  if (!reg) return;
  for (const entry of reg.entries.values()) entry.queue.dispose();
  reg.entries.clear();
  guardLeaving(reg);
}

/** A held snapshot was cancelled: its uploads stop, in whichever view's queue they wait. */
export function dropSnapshotUploads(root: BrainUiServices, snapshotId: string): void {
  const reg = registries.get(root.stores);
  if (!reg) return;
  for (const entry of reg.entries.values()) entry.queue.dropSnapshot(snapshotId);
}
