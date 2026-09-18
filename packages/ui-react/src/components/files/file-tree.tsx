import { useCallback, useEffect } from "react";
import { useFileStore } from "../../stores/file-store.js";
import type { FileEntry } from "@schlessera/brain-ui-sdk/protocol";
import { FileTreeView, TreeRow, fileKind } from "./file-tree-view.js";

/**
 * The container (S7): every node subscribes to the file store for its own
 * expansion, loading, error, active and highlight state, and renders a
 * `TreeRow` with its children rendered the same way. The store owns the
 * directory cache and the requests; the rows own nothing.
 */
export function FileTree() {
  const loadDir = useFileStore((s) => s.loadDir);
  const dirCache = useFileStore((s) => s.dirCache);
  const dirErrors = useFileStore((s) => s.dirErrors);

  useEffect(() => {
    if (!dirCache[""]) {
      void loadDir("");
    }
  }, [dirCache, loadDir]);

  const rootEntries = dirCache[""];
  const rootError = dirErrors[""];
  const retryRoot = useCallback(() => void loadDir(""), [loadDir]);

  return (
    <FileTreeView state={rootError ? "error" : rootEntries ? "ready" : "loading"} error={rootError} onRetry={retryRoot}>
      {rootEntries?.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </FileTreeView>
  );
}

function TreeNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  const isDir = entry.type === "dir";
  const expanded = useFileStore((s) => isDir && s.expandedDirs.has(entry.path));
  const loading = useFileStore((s) => isDir && s.loadingDirs.has(entry.path));
  const childEntries = useFileStore((s) => (isDir ? s.dirCache[entry.path] : undefined));
  const childError = useFileStore((s) => (isDir ? s.dirErrors[entry.path] : undefined));
  const toggleDir = useFileStore((s) => s.toggleDir);
  const loadDir = useFileStore((s) => s.loadDir);
  const openFile = useFileStore((s) => s.openFile);
  const isActive = useFileStore((s) => s.currentPath === entry.path);
  const highlighted = useFileStore((s) => isDir && s.highlightedDir === entry.path);
  const setHighlightedDir = useFileStore((s) => s.setHighlightedDir);
  const clearHighlight = useCallback(() => setHighlightedDir(null), [setHighlightedDir]);

  return (
    <TreeRow
      name={entry.name}
      kind={fileKind(entry.name, isDir, expanded)}
      depth={depth}
      active={isActive}
      loading={loading}
      highlighted={highlighted}
      error={expanded ? childError : undefined}
      onClick={() => void (isDir ? toggleDir(entry.path) : openFile(entry.path))}
      onRetry={() => void loadDir(entry.path)}
      onHighlightShown={clearHighlight}
    >
      {expanded && childEntries?.length
        ? childEntries.map((child) => <TreeNode key={child.path} entry={child} depth={depth + 1} />)
        : undefined}
    </TreeRow>
  );
}
