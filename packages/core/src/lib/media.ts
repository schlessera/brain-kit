/**
 * Media in a brain: which files are binaries worth a decision before they are
 * committed, and the size past which any file is. A brain is a text
 * knowledge base, and git keeps every version of a binary forever, so
 * `brain sync assess` classes these as MEDIA or LARGE for the sync skill to
 * ask about, and `brain doctor` reports the heaviest ones already tracked.
 * See docs/media.md.
 */

import type { BrainConfig } from "./config.js";
import { matchesAnyPattern } from "./tool-leftovers.js";

/** Images, PDF, audio, video and office documents. SVG is text and is not here. */
export const MEDIA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif",
  "pdf",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus",
  "mp4", "mov", "m4v", "webm", "mkv", "avi",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "key", "pages", "numbers",
]);

export interface MediaPolicy {
  maxTrackedBytes: number;
  track: string[];
  ignore: string[];
}

/** 5 MiB: well under GitHub's 50 MiB warning, and large for a note's attachment. */
export const DEFAULT_MEDIA_POLICY: MediaPolicy = { maxTrackedBytes: 5 * 1024 * 1024, track: [], ignore: [] };

export function mediaPolicy(config: BrainConfig | null | undefined): MediaPolicy {
  const media = config?.media;
  return {
    maxTrackedBytes: media?.maxTrackedBytes ?? DEFAULT_MEDIA_POLICY.maxTrackedBytes,
    track: media?.track ?? [],
    ignore: media?.ignore ?? [],
  };
}

export function isMediaPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 && MEDIA_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** The policy's own verdict for `path`, before any size or media class: `ignore` wins over `track`. */
export function mediaPolicyClass(path: string, policy: MediaPolicy): "ARTIFACT" | "TRACK" | null {
  if (matchesAnyPattern(path, policy.ignore)) return "ARTIFACT";
  if (matchesAnyPattern(path, policy.track)) return "TRACK";
  return null;
}

/** `bytes` for a person: `6.0 MB`, `20.0 KB`, `512 B`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
