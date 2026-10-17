import type { DiagramTypeRole } from "./skin.js";
/** Concrete generated geometry, never arbitrary SVG attributes or source markup. */
export type DiagramShapePaint = "line" | "primary" | "link" | "async" | "return" | "node" | "focal" | "cluster" | "text" | "muted" | "accent" | "ink" | "on-ink" | "none" | "lifeline" | "bar" | "zone" | "mask" | "focal-mask" | "message" | "cluster-mask";
export interface DiagramShapeBase {
 kind: "shape"; id: string; x: number; y: number; width: number; height: number;
 edgeId?: string; nodeId?: string; from?: string; to?: string;
 paint: DiagramShapePaint; strokeWidth?: number; family?: "axis" | "positional"; name?: string;
 arrow?: { x: number; y: number; dx: number; dy: number; head: "open" | "filled" | "hollow" };
}
export type DiagramShape = DiagramShapeBase & (
 | { shape: "line"; x1: number; y1: number; x2: number; y2: number }
 | { shape: "rect"; radius?: number }
 | { shape: "circle"; cx: number; cy: number; radius: number }
 | { shape: "polygon"; points: Array<{ x: number; y: number }> }
 | { shape: "path"; d: string }
 | { shape: "text"; text: string; textRole: DiagramTypeRole | "note"; align?: "start" | "middle" | "end"; fontSize?: number; fontWeight?: 400 | 500 | 600 }
);
