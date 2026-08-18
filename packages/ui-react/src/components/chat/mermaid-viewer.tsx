import { useMemo } from "react";
import { sizeSvgForExport } from "../../lib/mermaid.js";
import { ShareMenu } from "../share/share-menu.js";
import { ZoomViewer } from "../viewer/zoom-viewer.js";
import { buildDiagramShareOptions } from "./mermaid-share.js";

/**
 * Full-screen, pan-and-zoom view of one diagram. The gesture surface is
 * `ZoomViewer`, shared with the image viewer; this only supplies the SVG and
 * the diagram-specific share menu.
 *
 * The SVG string is the same one the block already rendered, so opening the
 * viewer costs no mermaid work. Both copies carry mermaid's ids; that is
 * harmless because the markup is byte-identical — a `url(#id)` in either copy
 * resolves to an identical marker.
 */
export function MermaidViewer({
  svg,
  source,
  onClose,
}: {
  svg: string;
  source: string;
  onClose: () => void;
}) {
  // Mermaid ships `width: 100%` + `max-width` on the svg, which has no
  // intrinsic size to measure or to scale from. Reuse the export sizer to pin
  // it to its viewBox pixels; the viewer's transform does all the scaling.
  const sizedSvg = useMemo(() => sizeSvgForExport(svg), [svg]);

  return (
    <ZoomViewer
      onClose={onClose}
      refitKey={sizedSvg}
      label="Diagram viewer"
      actions={<ShareMenu options={buildDiagramShareOptions(source)} title="Share diagram" />}
    >
      <div dangerouslySetInnerHTML={{ __html: sizedSvg }} />
    </ZoomViewer>
  );
}
