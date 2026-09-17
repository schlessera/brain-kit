import type { BrainUiRoot } from "../../root.js";
import { fetchAsFile, shareFile } from "../../lib/share.js";
import {
  SHARE_OPTIMIZED,
  formatBytes,
  optimizeImage,
  optimizedFilename,
} from "../../lib/image-optimize.js";
import type { ShareOption } from "../share/share-menu.js";

/**
 * Share options for one image, used by both the file viewer's header menu and
 * the full-screen image viewer.
 *
 * Two deliberate actions rather than one silently-processed payload:
 *
 * - **Original** ships the bytes untouched. This is the default and the first
 *   entry; a generated image is worth what its pixels are worth.
 * - **Optimized** re-encodes down toward a messaging-friendly size, and only
 *   when that actually changes something — an image already inside the target
 *   falls back to the original rather than being recompressed for show.
 */
export function buildImageShareOptions(
  root: BrainUiRoot,
  url: string,
  filename: string,
  opts: { mime?: string; bytes?: number } = {}
): ShareOption[] {
  const shareOriginal = async (): Promise<boolean> => {
    const file = await fetchAsFile(root, url, filename, opts.mime);
    return shareFile(file, { title: filename });
  };

  return [
    {
      id: "image-original",
      label: "Share original",
      hint: opts.bytes ? `Full quality · ${formatBytes(opts.bytes)}` : "Full quality",
      run: shareOriginal,
    },
    {
      id: "image-optimized",
      label: "Share optimized",
      hint: `JPEG, up to ${SHARE_OPTIMIZED.maxEdge}px · under ${formatBytes(SHARE_OPTIMIZED.maxBytes)}`,
      run: async () => {
        const original = await fetchAsFile(root, url, filename, opts.mime);
        const result = await optimizeImage(original, SHARE_OPTIMIZED);
        // null means "nothing to gain" (already small enough) or "could not be
        // decoded". Either way the original is the right thing to send, and
        // silently sending nothing would be worse than sending more bytes.
        if (!result) return shareFile(original, { title: filename });
        const file = new File([result.blob], optimizedFilename(filename), {
          type: "image/jpeg",
        });
        return shareFile(file, { title: filename });
      },
    },
  ];
}
