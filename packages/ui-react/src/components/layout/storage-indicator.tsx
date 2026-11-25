import { useMemo } from "react";
import { Button, type IconName } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { useStorageGuidance } from "../settings/storage/use-storage-guidance.js";
import { storageVolumes } from "../settings/storage/storage-volumes.js";
import { storageIndicator } from "../settings/storage/storage-indicator-model.js";
/**
 * A persistent status control opens the existing Settings pane; it adds no
 * destination. It names the worst volume as the pane's volume card does (#4547).
 */
export function StorageIndicator() {
  const root = useBrainUiRoot(),
    view = useStorageGuidance(root);
  const indicator = useMemo(
    () =>
      view.guidance
        ? storageIndicator(
            storageVolumes({ guidance: view.guidance, inventory: view.inventory }),
            view.guidance,
            view.error
          )
        : null,
    [view.guidance, view.inventory, view.error]
  );
  if (!view.guidance || !indicator || view.error === "forbidden") return null;
  const icon: IconName = indicator.severity ? "failed" : indicator.uncertain ? "unverified" : "ledger";
  return (
    <div
      className="shrink-0 border-b border-border px-2"
      data-storage-indicator=""
      data-storage-severity={indicator.severity ?? undefined}
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
        ariaLabel={indicator.ariaLabel}
        label={indicator.text}
        onClick={() => root.stores.ui.getState().openSettings("storage")}
      />
    </div>
  );
}
