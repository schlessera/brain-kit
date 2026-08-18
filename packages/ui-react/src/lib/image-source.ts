/**
 * Deriving a human filename from whatever an image's `src` happens to be.
 *
 * Three shapes reach the viewer: a files-API URL carrying the repo path in a
 * query parameter (what the chat rewrites `![](assets/x.png)` into), a plain
 * URL, and a `data:` / `blob:` URI with no name at all.
 */

const FALLBACK = "image";

/** Extension implied by a mime type, when the src itself carries no name. */
function extensionFor(mime?: string): string {
  if (!mime) return "";
  const subtype = mime.split("/")[1]?.split(";")[0]?.toLowerCase();
  if (!subtype) return "";
  if (subtype === "jpeg") return ".jpg";
  if (subtype === "svg+xml") return ".svg";
  if (/^[a-z0-9]+$/.test(subtype)) return `.${subtype}`;
  return "";
}

function basename(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? "";
  const last = clean.split("/").filter(Boolean).pop() ?? "";
  return last;
}

/**
 * Best available filename for an image source. Never returns an empty string —
 * a share sheet needs something to call the file.
 */
export function imageFilenameFromSrc(src: string, mime?: string): string {
  if (!src) return `${FALLBACK}${extensionFor(mime)}`;

  // A files-API URL keeps the real repo path in `?path=`; the URL's own last
  // segment is just the route ("content").
  const pathParam = /[?&]path=([^&]+)/.exec(src);
  if (pathParam?.[1]) {
    try {
      const name = basename(decodeURIComponent(pathParam[1]));
      if (name) return name;
    } catch {
      // Malformed percent-encoding — fall through to the generic paths.
    }
  }

  if (/^(data:|blob:)/i.test(src)) return `${FALLBACK}${extensionFor(mime)}`;

  const name = basename(src);
  // A bare directory URL, or a name with no extension, is not worth showing.
  if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
  return `${FALLBACK}${extensionFor(mime)}`;
}
