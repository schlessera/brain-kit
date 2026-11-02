import { parseImportedTrack, summarizeTrack } from "@schlessera/brain-geo";
import { TRACK_MAX_FILE_BYTES, type AttachmentKind, type AttachmentReader, type SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";

/**
 * Routing on stored bytes (#3153, docs/plans/chat-attachments.md §4). The MIME
 * type and file name are hints: they choose a display extension and decide
 * whether `trackRejected` is worth saying, and nothing else. Detection cannot
 * fail; the fallback is `binary`. It never claims the contents were read.
 */
export interface Detection {
  kind: AttachmentKind;
  reader: AttachmentReader;
  /** The media type detection established; null leaves the client's hint. */
  mediaType: string | null;
  /** The validated track, when `kind` is `track`. */
  track?: { format: "gpx" | "kml" | "geojson"; meta: Omit<SharedFileMeta, "name" | "path" | "mediaType" | "bytes"> & { summary: NonNullable<SharedFileMeta["summary"]> } };
  trackRejected?: true;
}

const SIGNATURE_BYTES = 1_024;
const TRACK_MEDIA = { gpx: "application/gpx+xml", kml: "application/vnd.google-earth.kml+xml", geojson: "application/geo+json" } as const;
const TRACK_HINT_NAME = /\.(?:gpx|kml|geojson)$/i;
const TRACK_HINT_MEDIA = new Set(Object.values(TRACK_MEDIA));

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);
}

/** A signature in the first 1,024 bytes, or null. */
function signatureOf(head: Uint8Array): { kind: AttachmentKind; mediaType: string | null } | null {
  const ascii = (text: string, at = 0) => startsWith(head, [...text].map((c) => c.charCodeAt(0)), at);
  // `%PDF-` may follow a little leading junk; readers accept it within the first KiB.
  const pdfAt = Buffer.from(head).indexOf("%PDF-");
  if (pdfAt >= 0 && pdfAt < SIGNATURE_BYTES) return { kind: "pdf", mediaType: "application/pdf" };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mediaType: "image/jpeg" };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mediaType: "image/png" };
  if (ascii("GIF87a") || ascii("GIF89a")) return { kind: "image", mediaType: "image/gif" };
  if (ascii("RIFF") && ascii("WEBP", 8)) return { kind: "image", mediaType: "image/webp" };
  if (ascii("ftyp", 4)) {
    const brand = String.fromCharCode(...head.subarray(8, 12));
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return { kind: "image", mediaType: "image/heic" };
    if (["mif1", "msf1", "heif"].includes(brand)) return { kind: "image", mediaType: "image/heif" };
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return { kind: "archive", mediaType: null };
  if (startsWith(head, [0x1f, 0x8b])) return { kind: "archive", mediaType: "application/gzip" };
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "archive", mediaType: "application/x-7z-compressed" };
  if (ascii("Rar!\u001a\u0007")) return { kind: "archive", mediaType: "application/vnd.rar" };
  return null;
}

/** Strict UTF-8 with no NUL and at most 1% C0 controls other than tab, CR and LF. */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) return null;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls++;
  }
  return controls * 100 > text.length ? null : text;
}

/**
 * Detect one stored original. `path` is the brain-relative path it is stored
 * at, which a valid track's summary names as its source.
 */
export function detectKind(bytes: Uint8Array, hints: { name: string; mediaType: string; path: string }): Detection {
  const signature = signatureOf(bytes.subarray(0, SIGNATURE_BYTES));
  if (signature) {
    const reader: AttachmentReader = signature.kind === "pdf" ? "pdf"
      // HEIC/HEIF has no inline frame here, so it has no reader either.
      : signature.kind === "image" && !signature.mediaType?.startsWith("image/hei") ? "image" : "none";
    return { kind: signature.kind, reader, mediaType: signature.mediaType };
  }
  const text = decodeText(bytes);
  if (text === null) return { kind: "binary", reader: "none", mediaType: null };
  const hintedTrack = TRACK_HINT_NAME.test(hints.name) || TRACK_HINT_MEDIA.has(hints.mediaType as (typeof TRACK_MEDIA)[keyof typeof TRACK_MEDIA]);
  if (bytes.byteLength <= TRACK_MAX_FILE_BYTES) {
    try {
      const imported = parseImportedTrack(text);
      const { geometry: _geometry, ...summary } = summarizeTrack(imported.track, { kind: "file", path: hints.path });
      return {
        kind: "track", reader: "track", mediaType: TRACK_MEDIA[imported.format],
        track: { format: imported.format, meta: { detected: imported.format,
          summary: { ...summary, waypointCount: imported.waypointCount, waypointOmitted: imported.waypointOmissions.length } } },
      };
    } catch { /* Not a track: a failed parse never forges track evidence. */ }
  }
  return { kind: "text", reader: "text", mediaType: null, ...(hintedTrack ? { trackRejected: true as const } : {}) };
}
