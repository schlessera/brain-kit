import { lazy } from "react";

// The one code-split boundary: sigma + graphology load only when a scene renders.
export const GraphCanvas = lazy(() => import("./graph-canvas.js"));
