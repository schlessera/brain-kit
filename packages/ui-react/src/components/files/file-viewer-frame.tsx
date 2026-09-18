import { Callout, EmptyState, FilterRow, Placeholder } from "@schlessera/brain-ui-kit";
import { Check, Copy, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The viewer's chrome, rendered from props (S7): the toolbar over the file,
 * and the three states the body can be in before there is a file to draw.
 * `FileViewer` is the container — it reads the store, builds the share
 * options (which need the root) and chooses the body renderer; this owns
 * how the frame looks.
 *
 * The Preview / Raw switch is the kit's `FilterRow`: two pills, one
 * selected, activation following focus, which is what a mode switch is.
 * The reveal and copy controls stay native icon buttons (titled; the kit
 * has no icon-only button) and the share menu arrives rendered.
 */
export type ViewMode = "preview" | "raw";

export interface ViewerToolbarProps {
  fileName: string;
  fullPath: string;
  size?: number;
  mode: ViewMode;
  /** Only markdown, HTML and standalone diagrams have a preview to switch to. */
  previewAvailable: boolean;
  copied: boolean;
  /** The share menu, already built by the container; null when nothing shares. */
  share: ReactNode;
  onMode: (mode: ViewMode) => void;
  onCopyPath: () => void;
  onReveal: () => void;
}

export function ViewerToolbar(p: ViewerToolbarProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
      <button
        type="button"
        onClick={p.onReveal}
        title="Reveal in tree"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" title={p.fullPath}>
          {p.fileName}
        </div>
        <div className="truncate text-[10px] text-muted-foreground" title={p.fullPath}>
          {p.fullPath}
          {p.size !== undefined && <span className="ml-2">· {formatSize(p.size)}</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={p.onCopyPath}
        title="Copy path"
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        {p.copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {p.share}
      {p.previewAvailable && (
        <div className="w-auto shrink-0">
          <FilterRow
            items={[
              { label: "Preview", onClick: () => p.onMode("preview") },
              { label: "Raw", onClick: () => p.onMode("raw") },
            ]}
            active={p.mode === "preview" ? 0 : 1}
            mono={false}
          />
        </div>
      )}
    </div>
  );
}

export function ViewerLoading() {
  return (
    <div className="px-6 py-6" aria-label="Loading file">
      <Placeholder variant="loading" lines={5} bordered={false} pad={0} />
    </div>
  );
}

export function ViewerError({ message }: { message: string }) {
  return (
    <div className="m-4" role="alert">
      <Callout tone="red" variant="banner" icon="failed" mono text={message} />
    </div>
  );
}

export function ViewerEmpty() {
  return (
    <EmptyState
      variant="no-results"
      icon="folder"
      tone="neutral"
      title="No file open"
      body="Select a file from the tree to view it."
      meta=""
      minHeight={240}
    />
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
