import { Button, type IconName } from "@schlessera/brain-ui-kit";
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
  const icon: IconName =
    value.severity === "critical" || value.severity === "low"
      ? "failed"
      : uncertain
      ? "unverified"
      : "ledger";
  return (
    <div
      className="shrink-0 border-b border-border px-2"
      data-storage-indicator=""
    >
      <Button
        tone="quiet"
        size="sm"
        icon={icon}
        style={{
          minHeight: 44,
          border: 0,
          borderRadius: 0,
          overflowWrap: "anywhere",
        }}
        ariaLabel={`Open Storage: ${label}${
          uncertain && value.severity && value.severity !== "observed"
            ? ", evidence out of date or unavailable"
            : ""
        }`}
        label={`Storage · ${label}${
          uncertain && value.severity && value.severity !== "observed"
            ? " · Check current evidence"
            : ""
        }`}
        onClick={() => root.stores.ui.getState().openSettings("storage")}
      />
    </div>
  );
}
