import { useEffect, useRef } from "react";
import { ChevronRight, Folder, FolderOpen, FileText, FileCode, FileImage, File as FileIcon, Loader2, AlertCircle } from "lucide-react";
import { useFileStore } from "../../stores/file-store.js";
import type { FileEntry } from "@schlessera/brain-ui-sdk/protocol";
import { cn } from "../../lib/utils.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".sh", ".bash", ".css", ".html", ".json", ".yaml", ".yml", ".toml", ".sql"]);

function iconForFile(name: string) {
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i).toLowerCase() : "";
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") return FileText;
  if (IMAGE_EXT.has(ext)) return FileImage;
  if (CODE_EXT.has(ext)) return FileCode;
  return FileIcon;
}

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

  if (rootError) {
    return (
      <div className="flex items-start gap-2 px-4 py-3 text-xs text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{rootError}</span>
      </div>
    );
  }

  if (!rootEntries) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading files...
      </div>
    );
  }

  return (
    <ul className="py-1 text-sm">
      {rootEntries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </ul>
  );
}

function TreeNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  const expanded = useFileStore((s) => s.expandedDirs.has(entry.path));
  const loading = useFileStore((s) => s.loadingDirs.has(entry.path));
  const childEntries = useFileStore((s) => (entry.type === "dir" ? s.dirCache[entry.path] : undefined));
  const childError = useFileStore((s) => (entry.type === "dir" ? s.dirErrors[entry.path] : undefined));
  const toggleDir = useFileStore((s) => s.toggleDir);
  const openFile = useFileStore((s) => s.openFile);
  const isActive = useFileStore((s) => s.currentPath === entry.path);
  const highlighted = useFileStore(
    (s) => entry.type === "dir" && s.highlightedDir === entry.path
  );
  const setHighlightedDir = useFileStore((s) => s.setHighlightedDir);
  const dirBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!highlighted || !dirBtnRef.current) return;
    dirBtnRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightedDir(null), 1800);
    return () => clearTimeout(t);
  }, [highlighted, setHighlightedDir]);

  const indent = { paddingLeft: depth * 14 + 8 };

  if (entry.type === "dir") {
    return (
      <li>
        <button
          ref={dirBtnRef}
          onClick={() => void toggleDir(entry.path)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-foreground transition-colors hover:bg-surface-raised",
            highlighted && "brain-tree-highlight"
          )}
          style={indent}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          {expanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-primary/80" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{entry.name}</span>
          {loading && <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />}
        </button>
        {expanded && (
          <ul>
            {childError && (
              <li className="flex items-center gap-1.5 px-2 py-1 text-xs text-destructive" style={{ paddingLeft: (depth + 1) * 14 + 8 }}>
                <AlertCircle className="h-3 w-3" /> {childError}
              </li>
            )}
            {childEntries?.map((child) => (
              <TreeNode key={child.path} entry={child} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const Icon = iconForFile(entry.name);
  return (
    <li>
      <button
        onClick={() => void openFile(entry.path)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-surface-raised",
          isActive ? "bg-surface-raised text-primary" : "text-foreground/90"
        )}
        style={indent}
      >
        <span className="h-3 w-3 shrink-0" />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  );
}
