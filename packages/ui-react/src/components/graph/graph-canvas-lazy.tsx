import { lazyChunk } from "../../lib/lazy-chunk.js";

// The one code-split boundary: sigma + graphology load only when a scene renders.
export const GraphCanvas = lazyChunk(() => import("./graph-canvas.js"));
