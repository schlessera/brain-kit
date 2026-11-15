import { Button, IconButton } from "@schlessera/brain-ui-kit";
import { FileText, X } from "lucide-react";
import type { AttachmentFile } from "@schlessera/brain-ui-sdk/protocol";
import { fileKindLabel, queuedFileCopy, storedFileCopy, type QueuedFile } from "../../lib/attachment-queue.js";
import { trackBytes } from "../../lib/track-uploads.js";

/**
 * One composer file (#3155, design §8.4): a queued upload, or an original
 * the host stored for this draft. Its accessible name is
 * `{name}, {kind}, {size}, {state}`; the words `readable`, `processed`,
 * `decoded` and `saved` never appear on a chip, because a stored file is
 * neither read nor, until the draft's save is acknowledged, saved.
 *
 * Retry and Upload again are text buttons with `reach`, so a coarse
 * pointer gets a 44px target without a 44px painted box; Remove is the
 * kit's 44px icon control.
 */
export function FileChip(p: {
  queued?: QueuedFile;
  stored?: AttachmentFile;
  /** A stored original this draft's id cannot bind (it came from another draft id). */
  detached?: boolean;
  /** An image original: whether its frame goes inline, and its thumbnail once made. */
  image?: { placement: "inline" | "not_inline" | "pending"; previewUrl?: string };
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const name = p.queued?.name ?? (p.stored ? p.stored.incomingName || p.stored.name : "") ?? "Unnamed file";
  const size = trackBytes(p.queued?.file.size ?? p.stored?.bytes ?? 0);
  const copy = p.detached
    ? { status: "not attached", detail: "It belongs to an earlier version of this draft. Choose it again to attach it." }
    : p.queued ? queuedFileCopy(p.queued) : storedFileCopy(p.stored!, p.image?.placement);
  const kind = p.stored ? fileKindLabel(p.stored) : "file";
  const state = p.queued?.state ?? (p.detached ? "detached" : "stored");
  const retry = p.queued && (p.queued.state === "failed" || p.queued.state === "unknown") && p.onRetry;
  return <div className="min-w-0 rounded-lg border border-border bg-surface text-foreground" data-file-chip={state}
    role="group" aria-label={`${name}, ${kind}, ${size}, ${copy.status}`}>
    <div className="flex min-w-0 items-center gap-2 pl-3">
      {p.image?.previewUrl && p.image.placement === "inline" && !p.detached
        ? <img src={p.image.previewUrl} alt="" data-file-thumbnail="" className="my-2 h-10 w-10 shrink-0 rounded-md border border-border object-cover" />
        : <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1 py-2">
        <div className="break-words text-sm font-medium">{name}</div>
        <div className="break-words text-xs text-muted-foreground" data-file-status="">{copy.status}</div>
        {copy.detail && <div className="break-words text-xs text-muted-foreground" data-file-detail="">{copy.detail}</div>}
      </div>
      {retry && <div className="px-2"><Button label={p.queued!.state === "unknown" ? "Upload again" : "Retry"} ariaLabel={`${p.queued!.state === "unknown" ? "Upload again" : "Retry"} ${name}`}
        tone="quiet" size="sm" block={false} reach onClick={p.onRetry} /></div>}
      <IconButton size="md" name={`Remove ${name}`} glyph={<X />} onClick={p.onRemove} />
    </div>
  </div>;
}
