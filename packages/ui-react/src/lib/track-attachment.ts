import type { AttachmentRowProps } from "@schlessera/brain-ui-kit";
import type { AttachmentFile, AttachmentReadEntry, SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
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

/** Merged inclusive ranges, ascending. */
function union(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const pageList = (ranges: [number, number][]) => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}\u2013${b}`)).join(", ");

/**
 * What the host's read records say about one sent original (design §8.4,
 * rev 3 §6), or null when nothing was read. Only recorded reads count: a
 * file's kind or reader never yields "read". Successful scopes are combined
 * across calls, so a later page range never hides an earlier one; a failure
 * shows only when nothing was read, and a changed original always shows.
 */
export function readCopy(entries: readonly AttachmentReadEntry[]): { text: string; tone: AttachmentRowProps["tone"] } | null {
  if (entries.length === 0) return null;
  if (entries.at(-1)!.outcome === "changed") return { text: "original changed since sending", tone: "amber" };
  const done = entries.filter((e) => (e.outcome === "read" || e.outcome === "partial") && e.scope);
  if (done.length > 0) {
    const allRead = done.every((e) => e.outcome === "read");
    const pages = done.flatMap((e) => (e.scope && "pages" in e.scope ? [e.scope] : []));
    if (pages.length > 0) {
      const covered = union(pages.map((s) => s.pages));
      const count = Math.max(...pages.map((s) => s.pageCount));
      const whole = covered.length === 1 && covered[0]![0] <= 1 && covered[0]![1] >= count;
      // A partial PDF read had blank pages or was cut short; which, the record does not say.
      if (!allRead) return { text: `partly read p. ${pageList(covered)}`, tone: "amber" };
      return { text: whole ? "read" : `read p. ${pageList(covered)}`, tone: "teal" };
    }
    const spans = done.flatMap((e) => (e.scope && "bytes" in e.scope ? [e.scope] : []));
    const total = Math.max(...spans.map((s) => s.totalBytes));
    // Byte scopes end exclusive; as inclusive ranges, two adjacent calls join.
    const covered = union(spans.map((s) => [s.bytes[0], s.bytes[1] - 1]));
    if (covered.length === 1 && covered[0]![0] === 0 && covered[0]![1] >= total - 1) return { text: "read", tone: "teal" };
    const head = covered[0]![0] === 0 ? covered[0]![1] + 1 : 0;
    return { text: head > 0 ? `read stopped at ${trackBytes(head)}` : "partly read", tone: "amber" };
  }
  switch (entries.at(-1)!.outcome) {
    case "no_text": return { text: "no text found \u00b7 may be scanned", tone: "amber" };
    case "encrypted": return { text: "couldn't read: password-protected", tone: "amber" };
    case "malformed": return { text: "couldn't read: damaged file", tone: "amber" };
    // A record keeps the outcome, not the reason, so the row names none.
    case "failed": return { text: "couldn't read", tone: "amber" };
    case "unavailable": return { text: "no reader for this kind of file", tone: "neutral" };
    default: return null;
  }
}

/**
 * A sent composer original (#3155): its name, kind and size, and what the
 * agent read of it. `reads` is that file's recorded reads (#3589), or
 * undefined while they are unknown (an older host, or the session's records
 * not arrived yet): then the row claims neither "read" nor "not read yet".
 */
export function attachmentRowProps(file: AttachmentFile, recorded?: readonly AttachmentReadEntry[]): AttachmentRowProps {
  // An image reaches the agent as its frame and its original, never through a
  // reader: its row makes no claim about reading (#3155).
  const reads = file.kind === "image" ? undefined : recorded;
  const read = reads ? readCopy(reads) : null;
  if (file.kind === "track" && file.track && !file.trackRejected) {
    const row = trackRowProps({ ...file.track, incomingName: file.incomingName ?? file.track.incomingName });
    if (!read) return row;
    return { ...row, meta: [...(Array.isArray(row.meta) ? row.meta : row.meta ? [row.meta] : []), read.text], tone: read.tone };
  }
  const label = file.incomingName || file.name || "Unnamed file";
  const size = Number.isFinite(file.bytes) && file.bytes >= 0 ? trackBytes(file.bytes) : undefined;
  const kind = file.trackRejected ? "Text" : fileKindLabel(file);
  const readable = file.reader === "pdf" || file.reader === "text" || file.reader === "track";
  const state = read?.text ?? (reads && readable ? "not read yet" : reads && file.reader === "none" ? "no reader for this kind of file" : "sent");
  const meta = [[file.reader === "none" && reads ? undefined : kind, size, state].filter(Boolean).join(" \u00b7 ")];
  if (file.reader === "none" && !reads) meta.push("No reader for this kind of file here.");
  return { kind: file.kind === "image" ? "image" : "doc", label, meta, tone: read?.tone ?? "neutral", actionIcon: "" };
}
