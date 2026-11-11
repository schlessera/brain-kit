import { MAX_IMAGES_PER_MESSAGE, MAX_TOTAL_IMAGE_BYTES, type AttachmentFile, type ChatImageAttachment } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { fileToAttachment, type PendingAttachment } from "./image-attachments.js";

/**
 * Inline frames of image originals (#3155, design §8.4 and §10).
 *
 * On a host with composer files an image is an original like any other: the
 * generic queue uploads its exact bytes and the host's detection names it an
 * image. The frame the model sees is derived from that original, as
 * `fileToAttachment` always prepared it, and carries the original's `fileId`
 * (`ChatImageAttachment.fileId`), so the host charges the pair once.
 *
 * A frame is page state, never draft content: drafts, snapshots and saves
 * name only the original. It is derived from the picked bytes when the host
 * stores them, or, after a reload, from the original read back
 * (`GET /api/attachments/:fileId`). Its preview URL is this registry's and is
 * revoked once no draft, snapshot or send of the root names the original.
 */
type ImageFrame =
  /** Being derived: a send that would carry it waits. */
  | { state: "pending" }
  | { state: "ready"; attachment: ChatImageAttachment; previewUrl: string; bytes: number }
  /** No frame can be made (an undecodable, too small or too large image): the original goes alone. */
  | { state: "none"; reason: string }
  /** The original could not be read back. Asked again on the next `ensureFrame`. */
  | { state: "failed" };

type Registry = { frames: Map<string, ImageFrame>; listeners: Set<() => void> };

const registries = new WeakMap<object, Registry>();

/** Whether a stored original gets a frame: the host's detection, never a name or MIME hint. */
export const isFramedImage = (file: Pick<AttachmentFile, "kind" | "reader">): boolean => file.kind === "image" && file.reader === "image";

function registry(root: BrainUiServices): Registry {
  let reg = registries.get(root.stores);
  if (!reg) {
    const created: Registry = { frames: new Map(), listeners: new Set() };
    // Preview cleanup: an original nothing names any more takes its frame with it.
    root.stores.drafts.subscribe(() => sweep(root, created));
    registries.set(root.stores, created);
    reg = created;
  }
  return reg;
}

function notify(reg: Registry) { for (const l of reg.listeners) l(); }

/** Every original a draft, a snapshot or a send of the root still names. */
function referenced(root: BrainUiServices): Set<string> {
  const state = root.stores.drafts.getState();
  const ids = new Set<string>();
  for (const d of Object.values(state.drafts)) {
    for (const f of d.files ?? []) ids.add(f.file.fileId);
    for (const s of d.snapshots ?? []) for (const f of s.files) ids.add(f.fileId);
  }
  for (const s of Object.values(state.sends)) for (const f of s.attachmentFiles ?? []) ids.add(f.file.fileId);
  return ids;
}

function sweep(root: BrainUiServices, reg: Registry) {
  if (reg.frames.size === 0) return;
  const live = referenced(root);
  let changed = false;
  for (const [id, frame] of reg.frames) {
    if (live.has(id)) continue;
    if (frame.state === "ready") URL.revokeObjectURL(frame.previewUrl);
    reg.frames.delete(id);
    changed = true;
  }
  if (changed) notify(reg);
}

/** The frame of an original, if this page has one or is making one. */
export function frameOf(root: BrainUiServices, fileId: string): ImageFrame | undefined {
  return registries.get(root.stores)?.frames.get(fileId);
}

/** Calls back whenever a frame starts, settles or goes. */
export function subscribeFrames(root: BrainUiServices, fn: () => void): () => void {
  const reg = registry(root);
  reg.listeners.add(fn);
  return () => { reg.listeners.delete(fn); };
}

/**
 * Derive the frame of an image original once: from `source` (the bytes just
 * picked) or else from the original the host keeps. A failed read is asked
 * again on the next call; a settled frame is never derived twice.
 */
export function ensureFrame(root: BrainUiServices, file: AttachmentFile, source?: Blob): void {
  if (!isFramedImage(file)) return;
  const reg = registry(root);
  const existing = reg.frames.get(file.fileId);
  if (existing && existing.state !== "failed") return;
  const pending: ImageFrame = { state: "pending" };
  reg.frames.set(file.fileId, pending);
  notify(reg);
  void (async () => {
    let next: ImageFrame;
    try {
      let blob = source;
      if (!blob) {
        const response = await root.request(`${root.apiBase()}/attachments/${encodeURIComponent(file.fileId)}`);
        if (!response.ok) throw Error(`status ${response.status}`);
        blob = await response.blob();
      }
      const picked = new File([blob], file.incomingName || file.name, { type: blob.type || file.mediaType });
      const result = await fileToAttachment(picked);
      next = "error" in result
        ? { state: "none", reason: result.error }
        : { state: "ready", attachment: { ...result.attachment, fileId: file.fileId }, previewUrl: result.previewUrl, bytes: result.bytes };
    } catch {
      next = { state: "failed" };
    }
    // Disposed, swept or replaced meanwhile: this result is no one's.
    if (reg.frames.get(file.fileId) !== pending) {
      if (next.state === "ready") URL.revokeObjectURL(next.previewUrl);
      return;
    }
    reg.frames.set(file.fileId, next);
    notify(reg);
  })();
}

/** The root is going, or its account locked: every preview is released. */
export function disposeFrames(root: BrainUiServices): void {
  const reg = registries.get(root.stores);
  if (!reg) return;
  for (const frame of reg.frames.values()) if (frame.state === "ready") URL.revokeObjectURL(frame.previewUrl);
  // Listeners stay: a view still mounted hears frames made after an unlock.
  reg.frames.clear();
  notify(reg);
}

/** Where an image original stands for one message. */
type FramePlacement = "inline" | "not_inline" | "pending";

/**
 * Which image originals travel with their frame (design §8.4). In order,
 * after the draft's legacy inline images, a frame goes inline while the
 * per-message image count and total frame bytes allow; past that budget, and
 * for an image no frame could be made of, the original goes alone. An image
 * whose frame is still being made is `pending`, and holds what comes after
 * it, so the placement never changes under a send.
 */
export function placeFrames(
  images: readonly AttachmentFile[],
  frame: (fileId: string) => ImageFrame | undefined,
  legacy: readonly Pick<PendingAttachment, "bytes">[] = [],
): Map<string, FramePlacement> {
  const placed = new Map<string, FramePlacement>();
  let count = legacy.length;
  let bytes = legacy.reduce((sum, a) => sum + a.bytes, 0);
  let waiting = false;
  for (const file of images) {
    if (!isFramedImage(file)) continue;
    const f = frame(file.fileId);
    if (waiting || !f || f.state === "pending") { placed.set(file.fileId, "pending"); waiting = true; continue; }
    if (f.state !== "ready" || count >= MAX_IMAGES_PER_MESSAGE || bytes + f.bytes > MAX_TOTAL_IMAGE_BYTES) { placed.set(file.fileId, "not_inline"); continue; }
    count++;
    bytes += f.bytes;
    placed.set(file.fileId, "inline");
  }
  return placed;
}

/**
 * The frames a message sends for these originals, each with its `fileId`,
 * or null while any is still being made. `previews` are data URLs the
 * transcript may keep: the registry's own URLs go with the original.
 */
export function framesFor(root: BrainUiServices, files: readonly AttachmentFile[], legacy: readonly Pick<PendingAttachment, "bytes">[] = []): { attachments: ChatImageAttachment[]; previews: { previewUrl: string; mediaType: ChatImageAttachment["mediaType"] }[] } | null {
  const placed = placeFrames(files, (id) => frameOf(root, id), legacy);
  if ([...placed.values()].includes("pending")) return null;
  const attachments: ChatImageAttachment[] = [];
  for (const file of files) {
    const f = frameOf(root, file.fileId);
    if (placed.get(file.fileId) === "inline" && f?.state === "ready") attachments.push(f.attachment);
  }
  return { attachments, previews: attachments.map((a) => ({ previewUrl: `data:${a.mediaType};base64,${a.data}`, mediaType: a.mediaType })) };
}
