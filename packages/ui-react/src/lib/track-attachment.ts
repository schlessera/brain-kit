import type { AttachmentRowProps } from "@schlessera/brain-ui-kit";
import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { trackBytes } from "./track-uploads.js";

/** Sent-file facts only; the existing composer keeps its own queue controls. */
export function trackRowProps(file: SharedFileMeta): AttachmentRowProps {
  const label = file.incomingName || file.name || "Unnamed track";
  const format = file.detected
    ? file.detected === "geojson" ? "GeoJSON" : file.detected.toUpperCase()
    : "track file";
  const size = Number.isFinite(file.bytes) && file.bytes >= 0 ? trackBytes(file.bytes) : undefined;
  const meta = [[format, size, "sent"].filter(Boolean).join(" · ")];
  if (file.name && file.name !== label) meta.push(`Staged as ${file.name}`);
  if (file.summary?.status === "no_line") {
    const count = file.summary.waypointCount;
    const waypoints = Number.isInteger(count) && count >= 0 ? `${count} waypoints; ` : "";
    meta.push(`${waypoints}no usable track line. The original is attached.`);
  }
  return { kind: "doc", label, meta, tone: "neutral", actionIcon: "" };
}
