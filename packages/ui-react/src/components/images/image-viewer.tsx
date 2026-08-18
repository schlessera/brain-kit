import { useState } from "react";
import { ShareMenu } from "../share/share-menu.js";
import { ZoomViewer } from "../viewer/zoom-viewer.js";
import { buildImageShareOptions } from "./image-share.js";

/**
 * Full-screen, pan-and-zoom view of one image — the same surface the mermaid
 * viewer uses, so a diagram and a picture behave identically.
 *
 * `maxFitScale: 1` because raster pixels are finite: opening a 400px image at
 * 250% would show nothing but interpolation. Zooming past 100% is still
 * available, it just is not where the viewer starts.
 */
export function ImageViewer({
  src,
  alt,
  filename,
  mime,
  bytes,
  onClose,
}: {
  src: string;
  alt?: string;
  filename: string;
  mime?: string;
  bytes?: number;
  onClose: () => void;
}) {
  // The natural size is unknown until the decode finishes, and `fit()` measures
  // the DOM — so the load event is what tells the viewer to fit.
  const [loaded, setLoaded] = useState(false);

  return (
    <ZoomViewer
      onClose={onClose}
      refitKey={loaded ? src : null}
      maxFitScale={1}
      label={`Image viewer: ${filename}`}
      actions={
        <ShareMenu
          options={buildImageShareOptions(src, filename, { mime, bytes })}
          title="Share image"
        />
      }
    >
      {/* Not lazy: this only mounts once the reader has opened the viewer. */}
      <img src={src} alt={alt ?? filename} onLoad={() => setLoaded(true)} draggable={false} />
    </ZoomViewer>
  );
}
