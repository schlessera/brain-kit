import { Download } from "lucide-react";
import type { FileContentResponse } from "@schlessera/brain-ui-sdk/protocol";
import { formatSize } from "./file-viewer-frame.js";

/** What a binary previewer is handed: the file, and where its bytes are served. */
export interface BinaryPreviewProps {
  content: FileContentResponse;
  rawUrl: string;
  filename: string;
  /** The browser could not show the file after all; the viewer falls back to the download card. */
  onUnsupported: () => void;
}

/** The line under a preview: type, size, and a link to the original bytes. */
export function BinaryMeta({
  content,
  rawUrl,
  filename,
  detail,
}: {
  content: FileContentResponse;
  rawUrl: string;
  filename: string;
  /** More about the file, e.g. its page count. */
  detail?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
      <span>
        {content.mime} · {formatSize(content.size)}
        {detail && ` · ${detail}`}
      </span>
      <span className="text-muted-foreground/40">·</span>
      <a
        href={rawUrl}
        download={filename}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground"
      >
        <Download className="h-3 w-3" />
        Download
      </a>
    </div>
  );
}
