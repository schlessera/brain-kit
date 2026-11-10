import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES, ATTACHMENT_MAX_TOTAL_BYTES, type AttachmentFile, type AttachmentLimits } from "@schlessera/brain-ui-sdk/protocol";
import { attachmentFileSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BrainUiRoot } from "../root.js";
import { trackBytes, trackStatus } from "./track-uploads.js";

/**
 * The composer's generic file queue (#3155, design §6.1 and §8.4).
 *
 * Every file a source hands over is uploaded, unfiltered, to the neutral
 * `POST /api/drafts/:draftId/files` route. The host decides what it is from
 * the stored bytes; nothing here routes by MIME type or extension. A file
 * leaves this queue once the host has stored it: it then belongs to the
 * draft (`ComposerDraft.files`), which saves its binding, and only an
 * acknowledged save of that binding reads as saved.
 *
 * Each item keeps one `Idempotency-Key` for its whole life, so asking again
 * after a lost answer returns the same `fileId` and never stores a second
 * copy. A missing answer is never read as "nothing was stored": the item
 * waits as `unknown` until it is uploaded again with the same key.
 */
type QueuedFileState =
  /** Not started yet, or the host was busy and it waits its turn. */
  | "waiting"
  | "uploading"
  /** Offline: it starts, or asks again, when the connection is back. */
  | "paused"
  /** Sent, and no answer came. The host may have stored it. */
  | "unknown"
  /** The host answered, but not with a stored file. Asking again is safe. */
  | "failed"
  /** The host refused it, so it is known not stored. */
  | "refused";

export interface QueuedFile {
  id: string;
  file: File;
  /** The name shown, with control and format characters removed. */
  name: string;
  /** The draft id it is uploaded to: the host's lineage for the original. */
  draftId: string;
  /** Kept for every retry of this file. */
  idempotencyKey: string;
  state: QueuedFileState;
  /** Chip copy for a failed or refused file. */
  status?: string;
  /** The longer explanation for the same state. */
  detail?: string;
  /** Why the host refused it (a received 4xx); the draft indicator names space refusals. */
  refusal?: "space" | "size" | "count" | "gone" | "invalid";
  /**
   * The held outgoing snapshot it belongs to (#3155): Send moved it out of
   * the composer, so the composer neither shows it nor waits for it, and its
   * result goes to that snapshot.
   */
  snapshotId?: string;
}

/** Pending items hold Send; failed and refused ones block it until removed or retried. */
export const queuedPending = (item: QueuedFile) => item.state === "waiting" || item.state === "uploading" || item.state === "paused" || item.state === "unknown";
export const queuedBlocking = (item: QueuedFile) => item.state === "failed" || item.state === "refused";

function fileDisplayName(name: string): string {
  return Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, "")).slice(0, 100).join("") || "Unnamed file";
}

/** `X-File-Name`: percent-encoded UTF-8, at most 1,024 bytes encoded (§6.1). */
export function fileNameHeader(name: string): string {
  const chars = Array.from(name);
  let encoded = encodeURIComponent(name);
  while (encoded.length > 1024 && chars.length > 0) { chars.pop(); encoded = encodeURIComponent(chars.join("")); }
  return encoded;
}

const KIND_LABEL: Record<AttachmentFile["kind"], string> = { pdf: "PDF", text: "Text", track: "Track", image: "Image", archive: "Archive", binary: "File" };

/** A stored original's kind, as the chip and the sent row name it. */
export const fileKindLabel = (file: Pick<AttachmentFile, "kind">): string => KIND_LABEL[file.kind] ?? "File";

/** What a stored original's chip says, and why (design §8.4). Stored is never read. */
export function storedFileCopy(file: AttachmentFile): { status: string; detail?: string } {
  const size = trackBytes(file.bytes);
  if (file.trackRejected) return { status: "Text · not a usable track", detail: "Stored as text. Track tools won't use it." };
  if (file.kind === "track" && file.track) {
    return { status: `Track · ${size} · ${trackStatus({ id: "", file: new File([], ""), name: "", state: "ready", meta: file.track })}` };
  }
  if (file.reader === "pdf" || file.reader === "text") {
    return { status: `${fileKindLabel(file)} · ${size} · not read yet`, detail: "Your agent opens it when it needs the contents." };
  }
  if (file.reader === "image") return { status: `${fileKindLabel(file)} · ${size}` };
  return { status: `${size} · no reader here`, detail: "Your agent has the file and can refer to it, but can't read this kind of file here." };
}

/** What a queued file's chip says, and why (design §8.4). */
export function queuedFileCopy(item: QueuedFile): { status: string; detail?: string } {
  switch (item.state) {
    case "waiting": return { status: "waiting to upload" };
    // `fetch` reports no upload progress, so no percentage is invented.
    case "uploading": return { status: "uploading…" };
    case "paused": return { status: "waiting for connection" };
    case "unknown": return { status: "checking upload…", detail: "The host didn't answer yet. Upload again sends the same file under the same key, so it can't store a second copy." };
    case "failed": return { status: item.status ?? "upload failed", detail: item.detail ?? "Retrying is safe: it won't store a second copy." };
    case "refused": return { status: item.status ?? "not stored", detail: item.detail };
  }
}

/** A limit as the design states it: decimal megabytes for the round ones (25 MB, 50 MB). */
const limitBytes = (n: number): string => (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000} MB` : trackBytes(n));

/** A refusal's copy: the host answered with a 4xx, so the file is known not stored. */
function refusal(status: number, body: { bound?: string; limit?: number; error?: string }): { status: string; detail: string; refusal: NonNullable<QueuedFile["refusal"]> } | null {
  if (status === 413) {
    if (body.bound === "draftCount") return { status: "not stored · too many files", detail: `Up to ${body.limit ?? ATTACHMENT_MAX_FILES} files per message.`, refusal: "count" };
    if (body.bound === "draftFiles") return { status: "not stored · message too large", detail: `Files can be up to ${limitBytes(body.limit ?? ATTACHMENT_MAX_TOTAL_BYTES)} together.`, refusal: "size" };
    return { status: "too large", detail: `Files can be up to ${limitBytes(body.limit ?? ATTACHMENT_MAX_FILE_BYTES)} each.`, refusal: "size" };
  }
  if (status === 507) return { status: "not stored · no space", detail: "This host's attachment space is full. Nothing was removed to make room.", refusal: "space" };
  if (status === 410) return { status: "not stored · draft gone", detail: "The draft it was for was deleted. Choose the file again to attach it.", refusal: "gone" };
  if (status === 400) return { status: "not stored", detail: "The host refused this file. Empty files can't be attached.", refusal: "invalid" };
  return null;
}

/** How long a busy host is given before the same upload is asked again. */
const BUSY_RETRY_MS = 2_000;
/** Uploads one composer runs at once; the host admits three across all clients. */
const PARALLEL = 2;

interface AttachmentQueueOptions {
  request: BrainUiRoot["request"];
  apiBase: string;
  /** The host stored it: the draft takes it from here. The item has already left the queue. */
  stored: (item: QueuedFile, file: AttachmentFile) => void;
  /**
   * It failed or was refused. True takes it out of the queue: its owner
   * (a held snapshot) has recorded the outcome.
   */
  settled?: (item: QueuedFile) => boolean;
  changed: () => void;
  /** Resolve a draft id that was rotated since the file was picked. */
  resolveDraft?: (draftId: string) => string;
}

export function createAttachmentQueue(options: AttachmentQueueOptions) {
  const { request, apiBase } = options;
  let items: QueuedFile[] = [];
  let online = true;
  let disposed = false;
  const running = new Map<string, AbortController>();
  const busyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const notify = () => { if (!disposed) options.changed(); };
  const has = (id: string) => items.some((item) => item.id === id);
  function update(id: string, patch: Partial<QueuedFile>) {
    items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
    const now = items.find((item) => item.id === id);
    if (now && (now.state === "failed" || now.state === "refused") && options.settled?.(now)) items = items.filter((item) => item.id !== id);
    notify();
  }

  async function upload(item: QueuedFile, controller: AbortController) {
    // A rotated draft's successor is where the binding goes; the host checks lineage.
    const draftId = options.resolveDraft?.(item.draftId) ?? item.draftId;
    update(item.id, { state: "uploading", draftId, status: undefined, detail: undefined, refusal: undefined });
    let answered = false;
    try {
      const response = await request(`${apiBase}/drafts/${encodeURIComponent(draftId)}/files`, {
        method: "POST",
        headers: {
          "Idempotency-Key": item.idempotencyKey,
          "Content-Type": item.file.type || "application/octet-stream",
          "X-File-Name": fileNameHeader(item.file.name || item.name),
        },
        body: item.file,
        signal: controller.signal,
      });
      answered = true;
      if (controller.signal.aborted || !has(item.id)) return;
      const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (controller.signal.aborted || !has(item.id)) return;
      if (response.status === 503) {
        update(item.id, { state: "waiting" });
        busyTimers.set(item.id, setTimeout(() => { busyTimers.delete(item.id); pump(); }, BUSY_RETRY_MS));
        return;
      }
      if (!response.ok) {
        const refused = refusal(response.status, (body ?? {}) as { bound?: string; limit?: number });
        if (refused) update(item.id, { state: "refused", ...refused });
        else update(item.id, { state: "failed", status: "upload failed" });
        return;
      }
      const parsed = attachmentFileSchema.safeParse(body);
      // A 2xx this client cannot read is not a stored file it knows: asking
      // again with the same key returns it, so it is a retryable failure.
      if (!parsed.success) { update(item.id, { state: "failed", status: "upload failed" }); return; }
      // As it is now: Send may have moved it into a held snapshot meanwhile.
      const current = items.find((other) => other.id === item.id) ?? item;
      items = items.filter((other) => other.id !== item.id);
      notify();
      options.stored(current, parsed.data as AttachmentFile);
    } catch {
      if (controller.signal.aborted || !has(item.id)) return;
      // No answer at all: the host may have stored it. Never "not stored".
      if (!answered) update(item.id, { state: online ? "unknown" : "paused" });
      else update(item.id, { state: "failed", status: "upload failed" });
    } finally {
      running.delete(item.id);
      pump();
    }
  }

  function pump() {
    if (!online || disposed) return;
    for (const item of items) {
      if (running.size >= PARALLEL) break;
      if (item.state !== "waiting" || running.has(item.id) || busyTimers.has(item.id)) continue;
      const controller = new AbortController();
      running.set(item.id, controller);
      void upload(item, controller);
    }
  }

  return {
    get files(): readonly QueuedFile[] { return items; },
    /**
     * Queue files for the draft `draftId`. `existing` is what that draft
     * already holds (images and stored originals); `limits` the host's
     * envelope. Files over it are not queued, and come back as one notice.
     */
    add(incoming: readonly File[], draftId: string, existing: { count: number; bytes: number }, limits: AttachmentLimits | null): string[] {
      const maxFiles = limits?.maxFiles ?? ATTACHMENT_MAX_FILES;
      const maxFileBytes = limits?.maxFileBytes ?? ATTACHMENT_MAX_FILE_BYTES;
      const maxTotal = limits?.maxTotalBytes ?? ATTACHMENT_MAX_TOTAL_BYTES;
      // A held snapshot's uploads are that message's, not this draft's.
      const own = items.filter((item) => !item.snapshotId);
      let count = existing.count + own.length;
      let bytes = existing.bytes + own.reduce((sum, item) => sum + item.file.size, 0);
      let overCount = 0;
      let overBytes = 0;
      const tooLarge: string[] = [];
      for (const file of incoming) {
        if (file.size > maxFileBytes) { tooLarge.push(fileDisplayName(file.name)); continue; }
        if (count >= maxFiles) { overCount++; continue; }
        if (bytes + file.size > maxTotal) { overBytes++; continue; }
        items = [...items, { id: crypto.randomUUID(), file, name: fileDisplayName(file.name), draftId, idempotencyKey: crypto.randomUUID(), state: online ? "waiting" : "paused" }];
        count++;
        bytes += file.size;
      }
      const notices: string[] = [];
      if (tooLarge.length) notices.push(`${tooLarge.join(", ")}: too large. Files can be up to ${limitBytes(maxFileBytes)} each.`);
      if (overCount) notices.push(`Up to ${maxFiles} files per message. ${overCount} ${overCount === 1 ? "wasn't" : "weren't"} added.`);
      if (overBytes) notices.push(`Files can be up to ${limitBytes(maxTotal)} together. ${overBytes} ${overBytes === 1 ? "wasn't" : "weren't"} added.`);
      notify(); pump();
      return notices;
    },
    /** Send moved these items into a held snapshot: their results are its. */
    assign(ids: readonly string[], snapshotId: string) {
      items = items.map((item) => (ids.includes(item.id) ? { ...item, snapshotId } : item));
      notify();
    },
    /** A held snapshot was cancelled: its uploads stop, and nothing is claimed about what the host keeps. */
    dropSnapshot(snapshotId: string) {
      for (const item of items) if (item.snapshotId === snapshotId) { running.get(item.id)?.abort(); clearTimeout(busyTimers.get(item.id)); busyTimers.delete(item.id); }
      items = items.filter((item) => item.snapshotId !== snapshotId);
      notify(); pump();
    },
    /** Remove from the composer only. Nothing is claimed about what the host keeps. */
    remove(id: string) {
      running.get(id)?.abort();
      clearTimeout(busyTimers.get(id));
      busyTimers.delete(id);
      items = items.filter((item) => item.id !== id);
      notify(); pump();
    },
    /** Retry a failure, or Upload again after no answer: the same bytes under the same key. */
    retry(id: string) {
      const item = items.find((other) => other.id === id);
      if (!item || !(item.state === "failed" || item.state === "unknown")) return;
      update(id, { state: online ? "waiting" : "paused", status: undefined, detail: undefined, refusal: undefined });
      pump();
    },
    setOnline(value: boolean) {
      online = value;
      if (!value) {
        for (const controller of running.values()) controller.abort();
        // A request that got no answer a moment before the page saw the drop
        // was the drop's (#1013): it waits with the others, and each reconnect
        // uploads it again once, under its same key (rev 5 §1).
        items = items.map((item) => (item.state === "waiting" || item.state === "uploading" || item.state === "unknown" ? { ...item, state: "paused" } : item));
      } else {
        items = items.map((item) => (item.state === "paused" ? { ...item, state: "waiting" } : item));
      }
      notify(); pump();
    },
    dispose() {
      disposed = true;
      for (const controller of running.values()) controller.abort();
      for (const timer of busyTimers.values()) clearTimeout(timer);
    },
  };
}

export type AttachmentQueue = ReturnType<typeof createAttachmentQueue>;
