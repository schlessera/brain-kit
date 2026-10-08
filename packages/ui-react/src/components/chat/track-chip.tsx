import { FileText, RotateCcw, X } from "lucide-react";
import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { trackBytes, trackStatus, type PendingTrack } from "../../lib/track-uploads.js";

/** Original name and canonical detected format stay separate from the staged filename. */
export function TrackChip({ track, file, onRemove, onRetry }: {
  track?: PendingTrack; file?: SharedFileMeta; onRemove?: () => void; onRetry?: () => void;
}) {
  const meta = file ?? track?.meta;
  const name = track?.name || meta?.incomingName || meta?.name || "Unnamed track";
  const format = meta?.detected ? meta.detected === "geojson" ? "GeoJSON" : meta.detected.toUpperCase() : "track file";
  const size = trackBytes(meta?.bytes ?? track?.file.size ?? 0);
  const state = track ? trackStatus(track) : "sent · staged";
  return <div className="min-w-0 rounded-lg border border-border bg-surface text-foreground" data-track-chip="" aria-label={`${name}, ${format} track, ${size}, ${state}`}>
    <div className="flex min-w-0 items-center gap-2 pl-3">
      <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 py-2">
        <div className="break-words text-sm font-medium">{name}</div>
        <div className="break-words text-xs text-muted-foreground"><span className="font-mono">{format}</span> · {size} · {state}</div>
      </div>
      {onRetry && track?.state === "failed" && <button type="button" className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2" onClick={onRetry} aria-label={`Retry ${name}`} title="Retry"><RotateCcw className="h-4 w-4" /></button>}
      {onRemove && <button type="button" className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:text-destructive focus-visible:outline focus-visible:outline-2" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove"><X className="h-4 w-4" /></button>}
    </div>
    {meta && meta.name !== name && <div className="px-3 pb-2 break-words text-xs text-muted-foreground">Staged as {meta.name}</div>}
    {meta?.summary?.status === "no_line" && <div className="px-3 pb-2 text-xs text-muted-foreground">{meta.summary.waypointCount} waypoints; no usable track line. The original is attached.</div>}
  </div>;
}
