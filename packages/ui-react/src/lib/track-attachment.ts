import type { AttachmentRowProps } from "@schlessera/brain-ui-kit";
import type { AttachmentFile, SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { trackBytes } from "./track-uploads.js";
import { fileKindLabel } from "./attachment-queue.js";

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

/**
 * A sent composer original (#3155): its name, kind and size, and nothing
 * about its contents. Which parts the agent read is recorded by the host
 * (`attachment_reads`) but not delivered to clients yet (#3589), so a sent
 * row claims neither "read" nor "not read yet".
 */
export function attachmentRowProps(file: AttachmentFile): AttachmentRowProps {
  if (file.kind === "track" && file.track && !file.trackRejected) return trackRowProps({ ...file.track, incomingName: file.incomingName ?? file.track.incomingName });
  const label = file.incomingName || file.name || "Unnamed file";
  const size = Number.isFinite(file.bytes) && file.bytes >= 0 ? trackBytes(file.bytes) : undefined;
  const kind = file.trackRejected ? "Text" : fileKindLabel(file);
  const meta = [[kind, size, "sent"].filter(Boolean).join(" · ")];
  if (file.reader === "none") meta.push("No reader for this kind of file here.");
  return { kind: file.kind === "image" ? "image" : "doc", label, meta, tone: "neutral", actionIcon: "" };
}
