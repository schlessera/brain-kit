import { useState } from "react";
import { IconButton } from "@schlessera/brain-ui-kit";
import { Expand } from "lucide-react";
import { imageFilenameFromSrc } from "../../lib/image-source.js";
import { ImageViewer } from "./image-viewer.js";

/**
 * An image that opens into the full-screen zoom viewer when tapped — the same
 * treatment a mermaid diagram gets, and for the same reason: the inline preview
 * is only as wide as the viewport, which on a phone means a generated image is
 * visible but not legible.
 *
 * Click-to-open rather than pinch-in-place: both the chat transcript and the
 * file panel scroll, and a zoom surface embedded in a scroller has to steal the
 * gestures that scrolling needs. Opening a dedicated stage keeps both intact.
 *
 * Sharing is deliberately NOT offered here. The hover affordance sits inside
 * markdown prose and inside a file panel, both of which clip overflow, and a
 * share menu that drops out of a clipping ancestor loses its lower entries. The
 * viewer this opens carries the share menu, and the file viewer's own header
 * has one too.
 *
 * The wrapper is a `span`, not a `div`: markdown puts images inside paragraphs,
 * and a block element there is invalid nesting.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  mime,
  bytes,
  toolbar = true,
  imgProps,
}: {
  src: string;
  alt?: string;
  /** Classes for the inline `<img>` itself. */
  className?: string;
  mime?: string;
  /** Byte size when known (the file viewer knows it; the chat does not). */
  bytes?: number;
  /**
   * Hover expand button. Off for thumbnails, where a 28px button would cover
   * the picture it is meant to act on — tapping the image still opens it.
   */
  toolbar?: boolean;
  imgProps?: Omit<React.ComponentPropsWithoutRef<"img">, "src" | "alt" | "className">;
}) {
  const [zoomed, setZoomed] = useState(false);
  const filename = imageFilenameFromSrc(src, mime);

  return (
    <span className="group relative inline-block max-w-full align-top">
      <img
        {...imgProps}
        src={src}
        alt={alt ?? ""}
        // The whole image is the affordance — the hover button is pointer-only,
        // and this has to work on a touch screen. Focusable and Enter/Space
        // activated because for a thumbnail (toolbar off) this is the ONLY way
        // in, so it cannot be pointer-only either.
        role="button"
        tabIndex={0}
        onClick={() => setZoomed(true)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setZoomed(true);
        }}
        className={className}
      />
      {toolbar && (
        <span className="absolute right-2 top-2 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <IconButton size="sm" tone="overlay" name="Open image" glyph={<Expand />} onClick={() => setZoomed(true)} />
        </span>
      )}
      {zoomed && (
        <ImageViewer
          src={src}
          alt={alt}
          filename={filename}
          mime={mime}
          bytes={bytes}
          onClose={() => setZoomed(false)}
        />
      )}
    </span>
  );
}
