import { FileRow, Placeholder } from "@schlessera/brain-ui-kit";
import type { FileKind } from "@schlessera/brain-ui-kit";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * The file tree's rows, rendered from props (S7, the `files` directory). The
 * design's `1e` screen draws the tree out of the kit's `FileRow` — folder,
 * open folder, file, image — so that is what a row is here. `FileTree` is
 * the container: it subscribes each node to the file store and decides
 * expansion, loading, errors and the active path; these views decide how
 * that looks.
 *
 * `TreeRow` is ONE row. The container renders it recursively so each node
 * keeps its own store subscription (a change deep in one folder re-renders
 * that row, not the tree); the children arrive as `children` already
 * rendered. A highlighted row (the tree was asked to reveal this folder)
 * scrolls itself into view and reports when the flash has run, so the
 * container can clear the request.
 */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"]);

export function fileKind(name: string, isDir: boolean, expanded: boolean): FileKind {
  if (isDir) return expanded ? "open" : "folder";
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i).toLowerCase() : "";
  return IMAGE_EXT.has(ext) ? "image" : "file";
}

export interface TreeRowProps {
  name: string;
  kind: FileKind;
  depth: number;
  /** The row the viewer is on. */
  active: boolean;
  /** A folder whose listing is in flight. */
  loading: boolean;
  /** The tree was asked to reveal this folder: flash it, scroll it into view. */
  highlighted: boolean;
  /** A folder's listing failed; shown under the row with a retry. */
  error?: string;
  /**
   * Days since the file was modified, given only when past the staleness
   * threshold (`staleness.ts`). D3 draws it as the gold left-edge dot and
   * the mono `stale 38d` meta, the same two marks the design's `1e` screen
   * uses; the container decides from `mtime`, the row only prints.
   */
  staleDays?: number;
  children?: ReactNode;
  onClick: () => void;
  onRetry?: () => void;
  onHighlightShown?: () => void;
  /**
   * The kit `FileRow` binds → on a closed folder to `onFold(true)` and ← on
   * an open one to `onFold(false)` (sixth pass §8: the ARIA tree pattern
   * requires them, and the footer prints them). Folders only.
   */
  onFold?: (open: boolean) => void;
}

/** How long the reveal flash runs before the request is cleared. */
export const HIGHLIGHT_MS = 1800;

export function TreeRow(p: TreeRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { highlighted, onHighlightShown } = p;
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => onHighlightShown?.(), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlighted, onHighlightShown]);

  return (
    <li>
      <div ref={ref} className={cn(highlighted && "brain-tree-highlight")}>
        <FileRow
          label={p.name}
          kind={p.kind}
          depth={p.depth}
          active={p.active}
          meta={p.loading ? "loading…" : p.staleDays !== undefined ? `stale ${p.staleDays}d` : undefined}
          metaTone={!p.loading && p.staleDays !== undefined ? "gold" : undefined}
          flag={p.staleDays !== undefined ? "gold" : undefined}
          onClick={p.onClick}
          onFold={p.onFold}
        />
      </div>
      {p.error ? (
        <div style={{ paddingLeft: 8 + (p.depth + 1) * 22 }} className="py-1 pr-2">
          <FileRow view="error" stateMessage="Folder unreadable" stateDetail={p.error} stateAction="Retry" onStateAction={p.onRetry} />
        </div>
      ) : null}
      {p.children ? <ul>{p.children}</ul> : null}
    </li>
  );
}

export interface FileTreeViewProps {
  /** The root listing: `loading` before it arrives, `error` when it failed, `ready` with rows. */
  state: "loading" | "error" | "ready";
  error?: string;
  children?: ReactNode;
  onRetry?: () => void;
}

export function FileTreeView(p: FileTreeViewProps) {
  if (p.state === "error") {
    return (
      <div className="px-3 py-2">
        <Placeholder variant="error" message="Files unreadable" detail={p.error} actionLabel="Retry" onAction={p.onRetry} />
      </div>
    );
  }
  if (p.state === "loading") {
    return (
      <div className="px-3 py-2" aria-label="Loading files">
        <Placeholder variant="loading" lines={4} bordered={false} pad={4} />
      </div>
    );
  }
  return (
    <ul className="py-1 text-sm" role="tree">
      {p.children}
    </ul>
  );
}
