/** The app-wide storage indicator's words (#4547), from the pane's own volume model. */
import type { StorageGuidanceResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { StorageVolume } from "./storage-volumes.js";

/** What the app-wide indicator says (#4547). */
interface StorageIndicatorView {
  /** Visible text: "Brain disk very low", "Storage warning · low · out of date". */
  text: string;
  /** The control's accessible name: the same words after "Open Storage:". */
  ariaLabel: string;
  /** The warned volume's severity; `null` when no volume is Low or Very low. */
  severity: "low" | "critical" | null;
  /** The named volume's id, when the name came from a volume. */
  volumeId: string | null;
  uncertain: boolean;
}

/**
 * The indicator names the worst volume by the pane's own naming and order
 * (`storageVolumes`), so it and the volume card read the same. A volume that
 * could not be identified reads "Storage warning" rather than a guessed name.
 * Stale and unknown evidence keep their qualifier, visibly and in the name.
 */
export function storageIndicator(
  volumes: readonly StorageVolume[],
  guidance: StorageGuidanceResponse,
  error: string | null = null
): StorageIndicatorView {
  const warned = volumes.find((volume) => volume.severity === "critical" || volume.severity === "low");
  const uncertain = error !== null || guidance.state !== "current" || guidance.pending;
  if (!warned) {
    // No volume is Low or Very low: the existing neutral wording.
    const words =
      guidance.severity === "critical"
        ? "Very low space"
        : guidance.severity === "low"
        ? "Low space"
        : uncertain
        ? "Capacity unknown"
        : "Capacity observed";
    const warning = guidance.severity === "critical" || guidance.severity === "low";
    return {
      text: `Storage · ${words}`,
      ariaLabel: `Open Storage: ${words}`,
      severity: warning ? (guidance.severity as "low" | "critical") : null,
      volumeId: null,
      uncertain,
    };
  }
  const severity = warned.severity as "low" | "critical";
  const level = severity === "critical" ? "very low" : "low";
  // The generic fallback still says how bad it is; it never guesses a name.
  const base = warned.identified ? `${warned.name} ${level}` : `Storage warning \u00b7 ${level}`;
  const qualifier = warned.stale ? "out of date" : uncertain || warned.uncertain ? "evidence unknown" : null;
  return {
    text: qualifier ? `${base} · ${qualifier}` : base,
    ariaLabel: `Open Storage: ${qualifier ? `${base}, ${qualifier}` : base}`,
    severity,
    volumeId: warned.identified ? warned.id : null,
    uncertain: uncertain || warned.uncertain,
  };
}
