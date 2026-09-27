import { useState, type ComponentType } from "react";
import { FileWarning, Download } from "lucide-react";
import type { FileContentResponse } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { ZoomableImage } from "../images/zoomable-image.js";
import { BinaryMeta, type BinaryPreviewProps } from "./binary-preview.js";
import { formatSize } from "./file-viewer-frame.js";
import { PdfPreview } from "./pdf-preview.js";

/**
 * MIME type → previewer. A key is a full type (`application/pdf`) or a whole
 * top-level type (`video/*`), and a full type wins over its wildcard. A new
 * format is one entry here plus its component; anything without an entry gets
 * the download card.
 *
 * Candidates with no previewer yet: Office documents (docx, xlsx, pptx), EPUB
 * and archives.
 */
export const BINARY_PREVIEWERS: Readonly<Record<string, ComponentType<BinaryPreviewProps>>> = {
  "image/*": ImagePreview,
  "application/pdf": PdfPreview,
  "audio/*": AudioPreview,
  "video/*": VideoPreview,
};

export function binaryPreviewerFor(mime: string | undefined): ComponentType<BinaryPreviewProps> | null {
  if (!mime) return null;
  const type = mime.split(";")[0]!.trim().toLowerCase();
  return BINARY_PREVIEWERS[type] ?? BINARY_PREVIEWERS[`${type.split("/")[0]}/*`] ?? null;
}

export function FileViewerBinary({ content }: { content: FileContentResponse }) {
  const root = useBrainUiRoot();
  const rawUrl = `${root.apiBase()}/files/content?path=${encodeURIComponent(content.path)}&raw=1`;
  const filename = content.path.split("/").pop() ?? content.path;
  // Keyed by path and mtime, so another file, or this one regenerated, gets a fresh attempt.
  const revision = `${content.path}\n${content.mtime}`;
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const Previewer = binaryPreviewerFor(content.mime);

  if (!Previewer || unsupported === revision) {
    return <PreviewUnavailable content={content} rawUrl={rawUrl} filename={filename} />;
  }
  return (
    <Previewer
      content={content}
      rawUrl={rawUrl}
      filename={filename}
      onUnsupported={() => setUnsupported(revision)}
    />
  );
}

function ImagePreview({ content, rawUrl, filename }: BinaryPreviewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <div className="flex max-h-full max-w-full overflow-auto rounded-lg border border-border bg-surface p-2">
        {/* Tap to open the zoom viewer: the panel is narrow, so the preview is
            a thumbnail of anything larger than it. */}
        <ZoomableImage
          src={rawUrl}
          alt={content.path}
          className="max-h-[70vh] max-w-full cursor-zoom-in object-contain"
          mime={content.mime}
          bytes={content.size}
        />
      </div>
      <BinaryMeta content={content} rawUrl={rawUrl} filename={filename} />
    </div>
  );
}

function AudioPreview({ content, rawUrl, filename, onUnsupported }: BinaryPreviewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <audio
        controls
        preload="metadata"
        src={rawUrl}
        aria-label={filename}
        onError={onUnsupported}
        className="w-full max-w-md"
      />
      <BinaryMeta content={content} rawUrl={rawUrl} filename={filename} />
    </div>
  );
}

function VideoPreview({ content, rawUrl, filename, onUnsupported }: BinaryPreviewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      {/* playsInline: without it, iPhone Safari takes the video fullscreen on play. */}
      <video
        controls
        playsInline
        preload="metadata"
        src={rawUrl}
        aria-label={filename}
        onError={onUnsupported}
        className="max-h-[70vh] max-w-full rounded-lg border border-border"
      />
      <BinaryMeta content={content} rawUrl={rawUrl} filename={filename} />
    </div>
  );
}

function PreviewUnavailable({ content, rawUrl, filename }: { content: FileContentResponse; rawUrl: string; filename: string }) {
  return (
    <div className="m-6 flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6">
      <div className="flex items-center gap-2 text-foreground">
        <FileWarning className="h-5 w-5 text-muted-foreground" />
        <span className="font-medium">Preview not available</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {content.mime ?? "unknown"} · {formatSize(content.size)}
      </div>
      <a
        href={rawUrl}
        download={filename}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-raised"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </a>
    </div>
  );
}
