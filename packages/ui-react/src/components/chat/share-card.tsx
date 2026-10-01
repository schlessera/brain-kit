import { trackBytes, trackDisplayName } from "../../lib/track-uploads.js";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Share2, X } from "lucide-react";
import type { StoredShare } from "@schlessera/brain-ui-sdk/share-target";
import { useShareIntake } from "../../hooks/use-share-intake.js";
import { useShareStore } from "../../stores/share-store.js";

/**
 * What arrived from the system share sheet, waiting for a tap.
 *
 * This card is the security boundary, not a convenience. The share target is
 * reachable by any website — a page that auto-submits a cross-site form to it
 * is indistinguishable from a real share — so nothing is uploaded and no agent
 * turn starts until the user has seen what arrived and confirmed it. Do not
 * "streamline" this into an automatic send.
 */

function useThumbnails(files: File[]): { url: string; name: string }[] {
  const images = useMemo(
    () => files.filter((file) => file.type.startsWith("image/")).slice(0, 4),
    [files]
  );
  const [thumbs, setThumbs] = useState<{ url: string; name: string }[]>([]);

  useEffect(() => {
    const created = images.map((file) => ({
      url: URL.createObjectURL(file),
      name: file.name,
    }));
    setThumbs(created);
    // These object URLs belong to this component alone — the ones handed to a
    // sent message are made separately, and the chat store owns those.
    return () => {
      for (const thumb of created) URL.revokeObjectURL(thumb.url);
      setThumbs([]);
    };
  }, [images]);

  return thumbs;
}

function ShareCard({
  record,
  busy,
  phase,
  onConfirm,
  onDismiss,
}: {
  record: StoredShare;
  busy: boolean;
  phase: "review" | "uploading" | "parsing" | "paused";
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const thumbs = useThumbnails(record.files);
  const otherFiles = record.files.filter((file) => !file.type.startsWith("image/"));

  return (
    <div className="mb-2 rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Share2 className="h-3.5 w-3.5" />
        <span className="flex-1">Shared to your brain</span>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss shared files"
          className="flex min-h-11 min-w-11 items-center justify-center rounded transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex gap-3">
        {thumbs.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1">
            {thumbs.map((thumb) => (
              <img
                key={thumb.url}
                src={thumb.url}
                alt={thumb.name}
                className="h-14 w-14 rounded-md border border-border object-cover"
              />
            ))}
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-1 text-sm">
          {record.title && (
            <div className="truncate font-medium text-foreground">{record.title}</div>
          )}
          {record.url && (
            <div className="truncate text-xs text-muted-foreground">{record.url}</div>
          )}
          {record.text && (
            <div className="line-clamp-3 text-xs text-muted-foreground">
              {record.text}
            </div>
          )}
          {otherFiles.map((file, index) => (
            <div key={index} className="break-words text-xs text-muted-foreground">
              {trackDisplayName(file.name)} · {trackBytes(file.size)} · {phase === "paused" ? "waiting for connection" : busy ? phase === "parsing" ? "reading file…" : "uploading…" : "awaiting your review"}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-primary-fill px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Add to brain
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-11 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground disabled:opacity-60"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Drives the intake and renders the head of the queue.
 *
 * One card at a time, and the next only after the current one is gone: the
 * client has a single unbound chat draft, so two turns started before the first
 * `session_info` arrives would share a buffer and lose the second transcript.
 */
export function ShareIntake() {
  const { confirm, dismiss } = useShareIntake();
  const queue = useShareStore((s) => s.queue);
  const busy = useShareStore((s) => s.busy);
  const phase = useShareStore((s) => s.phase);
  const error = useShareStore((s) => s.error);
  const notes = useShareStore((s) => s.notes);
  const setError = useShareStore((s) => s.setError);

  const head = queue[0];
  if (!head && !error) return null;

  return (
    <>
      {error && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive-fill/5 px-3 py-2 text-[11px] text-destructive">
          <div className="flex-1">{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            title="Dismiss"
            className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {notes.length > 0 && (
        <div className="mb-2 space-y-0.5 rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground">
          {notes.map((note, i) => (
            <div key={i}>{note}</div>
          ))}
        </div>
      )}

      {head && (
        <ShareCard
          record={head}
          busy={busy}
          phase={phase}
          onConfirm={() => void confirm(head)}
          onDismiss={() => dismiss(head)}
        />
      )}

      {queue.length > 1 && (
        <div className="mb-2 text-[11px] text-muted-foreground">
          {queue.length - 1} more share(s) waiting.
        </div>
      )}
    </>
  );
}
