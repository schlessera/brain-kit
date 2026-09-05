import { Suspense, lazy, useEffect } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useFileStore } from "../../stores/file-store.js";
import { useDeferredUnmount } from "../../hooks/use-deferred-unmount.js";
import { cn } from "../../lib/utils.js";

/** Matches the `duration-300` slide-out below. */
const SLIDE_OUT_MS = 300;

/**
 * The tree and the viewers load the first time the panel is opened. Together
 * they carry the markdown, HTML, image and PDF viewers, none of which the chat
 * surface needs to have on hand.
 */
const FileTree = lazy(() => import("./file-tree.js").then((m) => ({ default: m.FileTree })));
const FileViewer = lazy(() => import("./file-viewer.js").then((m) => ({ default: m.FileViewer })));

export function FilePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const currentPath = useFileStore((s) => s.currentPath);
  const treeExpanded = useFileStore((s) => s.treeExpanded);
  const setTreeExpanded = useFileStore((s) => s.setTreeExpanded);
  const closeFile = useFileStore((s) => s.closeFile);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Sync hash route to current file. When the panel closes, strip the
  // `#/files*` segment entirely so a reload doesn't reopen it.
  useEffect(() => {
    if (!open) {
      if (window.location.hash.startsWith("#/files")) {
        // Replace with the pathname (no hash) so reload lands on the chat.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      return;
    }
    if (currentPath) {
      const target = `#/files/${currentPath}`;
      if (window.location.hash !== target) {
        history.replaceState(null, "", target);
      }
    } else if (window.location.hash.startsWith("#/files")) {
      history.replaceState(null, "", "#/files");
    }
  }, [open, currentPath]);

  // The body outlives `open` by the slide-out, then unmounts: a closed panel
  // was otherwise keeping the whole file tree mounted behind the chat page.
  const showContent = useDeferredUnmount(open, SLIDE_OUT_MS);
  const showTree = showContent && (!currentPath || treeExpanded);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 transition-opacity md:bg-black/20"
          onClick={onClose}
        />
      )}

      <div
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-border bg-surface shadow-[0_16px_48px_rgba(0,0,0,0.5)] md:w-[560px]",
          "transform transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-[family-name:var(--font-display)] text-lg text-foreground">
            Files
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2.5 md:p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <X className="h-5 w-5 md:h-4 md:w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Tree toggle strip — visible when a file is open */}
          {showContent && currentPath && (
            <div className="flex items-center gap-1 border-b border-border bg-surface-raised/40 px-3 py-1.5">
              <button
                onClick={() => setTreeExpanded(!treeExpanded)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                {treeExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {treeExpanded ? "Hide tree" : "Show tree"}
              </button>
              <button
                onClick={closeFile}
                className="ml-auto rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                Close file
              </button>
            </div>
          )}

          {/* Tree area */}
          {showTree && (
            <div
              className={cn(
                "overflow-y-auto",
                currentPath ? "max-h-[45vh] border-b border-border" : "flex-1"
              )}
            >
              <Suspense fallback={null}>
                <FileTree />
              </Suspense>
            </div>
          )}

          {/* Viewer area */}
          {showContent && currentPath && (
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <FileViewer />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
