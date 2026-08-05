import { FileWarning, Download } from "lucide-react";
import type { FileContentResponse } from "@schlessera/brain-ui-sdk/protocol";
import { API_BASE } from "../../lib/backend.js";

export function FileViewerBinary({ content }: { content: FileContentResponse }) {
  const isImage = content.mime?.startsWith("image/");
  const rawUrl = `${API_BASE}/files/content?path=${encodeURIComponent(content.path)}&raw=1`;

  if (isImage) {
    const filename = content.path.split("/").pop() ?? content.path;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <div className="flex max-h-full max-w-full overflow-auto rounded-lg border border-border bg-surface p-2">
          <img src={rawUrl} alt={content.path} className="max-h-[70vh] max-w-full object-contain" />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>
            {content.mime} · {formatSize(content.size)}
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
      </div>
    );
  }

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
        download={content.path.split("/").pop() ?? content.path}
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
