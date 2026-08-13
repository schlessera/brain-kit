import { X, FileText, Crosshair, Expand } from "lucide-react";
import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { useFileStore } from "../../stores/file-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useGraphStore } from "../../stores/graph-store.js";

/**
 * Detail card for the selected node, docked to the bottom-left of the canvas
 * (bottom sheet width on phones). "Open note" hands over to the file viewer
 * panel — the same hand-off the search modal uses.
 */
export function NodePopover({
  node,
  communityLabel,
}: {
  node: GraphNodePayload;
  communityLabel?: string | null;
}) {
  const openFile = useFileStore((s) => s.openFile);
  const setFilePanelOpen = useUIStore((s) => s.setFilePanelOpen);
  const mode = useGraphStore((s) => s.mode);
  const select = useGraphStore((s) => s.select);
  const setMode = useGraphStore((s) => s.setMode);
  const setLocalParams = useGraphStore((s) => s.setLocalParams);
  const expandNode = useGraphStore((s) => s.expandNode);

  const isVirtual = node.virtual === true;

  function handleOpen() {
    setFilePanelOpen(true);
    void openFile(node.path);
  }

  function handleFocus() {
    // Re-center the local view on this node (switching mode when needed).
    if (mode !== "local") setMode("local");
    setLocalParams({ center: node.path });
    select(null);
  }

  return (
    <div className="pointer-events-auto absolute inset-x-2 bottom-2 z-10 rounded-xl border border-border bg-surface-overlay/95 p-4 shadow-2xl backdrop-blur md:inset-x-auto md:left-4 md:bottom-4 md:w-80">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {isVirtual ? "root" : node.type}
            </span>
            {communityLabel && (
              <span className="truncate text-[10px] text-muted-foreground">
                {communityLabel}
              </span>
            )}
          </div>
          <h3 className="mt-1 truncate text-sm font-medium text-foreground">
            {node.title || node.path}
          </h3>
          <p className="truncate font-mono text-[10px] text-muted-foreground/60">
            {node.path}
          </p>
        </div>
        <button
          onClick={() => select(null)}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex gap-4 text-[11px] text-muted-foreground">
        <span>{node.inDegree} in</span>
        <span>{node.outDegree} out</span>
        {node.distance !== undefined && node.distance > 0 && (
          <span>
            {node.distance} hop{node.distance === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!isVirtual && (
          <ActionButton icon={FileText} label="Open note" onClick={handleOpen} primary />
        )}
        {!isVirtual && (mode !== "local" || node.distance !== 0) && (
          <ActionButton icon={Crosshair} label="Focus here" onClick={handleFocus} />
        )}
        {mode === "local" && !isVirtual && node.distance !== 0 && (
          <ActionButton
            icon={Expand}
            label="Expand"
            onClick={() => void expandNode(node.path)}
          />
        )}
      </div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  primary,
}: {
  icon: typeof X;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        primary
          ? "flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          : "flex min-h-9 items-center gap-1.5 rounded-lg bg-surface-raised px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-overlay"
      }
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
