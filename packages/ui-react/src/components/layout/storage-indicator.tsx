import { CircleHelp, TriangleAlert, HardDrive } from "lucide-react";
import { useBrainUiRoot } from "../../root-context.js";
import { useStorageGuidance } from "../settings/storage/use-storage-guidance.js";
/** A persistent status control opens the existing Settings pane; it adds no destination. */
export function StorageIndicator() {
  const root = useBrainUiRoot(),
    view = useStorageGuidance(root);
  if (!view.guidance || view.error === "forbidden") return null;
  const value = view.guidance,
    uncertain =
      view.error !== null || value.state !== "current" || value.pending;
  const label =
    value.severity === "critical"
      ? "Very low space"
      : value.severity === "low"
      ? "Low space"
      : uncertain
      ? "Capacity unknown"
      : "Capacity observed";
  const Glyph =
    value.severity === "critical" || value.severity === "low"
      ? TriangleAlert
      : uncertain
      ? CircleHelp
      : HardDrive;
  return (
    <div
      className="shrink-0 border-b border-border px-2"
      data-storage-indicator=""
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ overflowWrap: "anywhere" }}
        aria-label={`Open Storage: ${label}${
          uncertain && value.severity && value.severity !== "observed"
            ? ", evidence out of date or unavailable"
            : ""
        }`}
        onClick={() => root.stores.ui.getState().openSettings("storage")}
      >
        <Glyph size={16} className="shrink-0" aria-hidden="true" />
        <span>
          Storage · {label}
          {uncertain && value.severity && value.severity !== "observed"
            ? " · Check current evidence"
            : ""}
        </span>
      </button>
    </div>
  );
}
