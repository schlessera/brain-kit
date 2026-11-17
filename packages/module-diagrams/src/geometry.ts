import { buildPositionalDiagram } from "./positional-layout.js";
import { typeWidthBudget } from "./skin.js";
import { buildAxisDiagram } from "./axis-layout.js";
import type { DiagramShape } from "./shape.js";
import { diagramSpecSchema, FREE_LAYOUT_TYPES, AXIS_TYPES, type DiagramSpec } from "./spec.js";

export interface DiagramPoint { x: number; y: number }
export interface DiagramBox { x: number; y: number; width: number; height: number }
export type DiagramSide = "left" | "right" | "top" | "bottom";
export interface DiagramPort extends DiagramPoint { node: string; side: DiagramSide }
export interface DiagramBridge extends DiagramPoint { segment: number; radius: 6; over: string }
export interface DiagramConnector {
  kind: "connector"; id: string; edge: number; from: DiagramPort; to: DiagramPort;
  points: DiagramPoint[]; path: string; radius: 8; bridges: DiagramBridge[];
  dashed: boolean; transit: string[];
}
export interface DiagramLabelMask extends DiagramBox { kind: "label-mask"; edge: number; opaque: true; gap: 8; segment: number }
export interface DiagramEdgeLabel extends DiagramBox { kind: "edge-label"; edge: number; text: string; fontSize: number }
export interface DiagramNode extends DiagramBox { nodeKind?: "compute" | "endpoint" | "managed"; parent?: string; target?: string; shape?: "start" | "end" | "step" | "decision" | "merge" | "state" | "initial" | "final"; fields?: Array<{ name: string; type?: string; key?: "PK" | "FK" }>; rank?: number; fanIn?: number; kind: "node"; id: string; label: string; focal: boolean; sub?: string; tag?: string; role?: string; link?: string }
export interface DiagramGroup extends DiagramBox { scopeKind?: "admin" | "traffic"; parent?: string; kind: "group"; id: string; label: string; focal: boolean }
export interface DiagramCardinality extends DiagramBox { kind: "cardinality"; edge: number; end: "from" | "to"; text: string }
export type DiagramElement = DiagramShape | DiagramCardinality | DiagramConnector | DiagramLabelMask | DiagramEdgeLabel | DiagramNode | DiagramGroup;
export interface DiagramTree { schema_version: 1; type: DiagramSpec["type"]; grammar?: "architecture-containment"; title: string; desc: string; viewBox: DiagramBox; elements: DiagramElement[] }
export interface DiagramGeometryOptions { labelFontSize?: number; labelLineHeight?: number }
export interface DiagramGeometryFinding { path: string; code: "unroutable" | "scene_bounds"; message: string }
export class DiagramGeometryError extends Error {
  readonly findings: DiagramGeometryFinding[];
  constructor(findings: DiagramGeometryFinding[]) { super(findings.map(item => item.message).join("; ")); this.name = "DiagramGeometryError"; this.findings = findings; }
}
/** Include the painted border and the non-admin heading mask above the group. */
export function diagramGroupBounds(group: DiagramGroup): DiagramBox {
  const top = group.scopeKind === "admin" ? 1 : 8;
  return { x: group.x - 1, y: group.y - top, width: group.width + 2, height: group.height + top + 1 };
}
/**
 * The painted heading of a group: an admin scope's 24px header band, or the
 * masked label that sits across a group's top border (see the group case in
 * `svg-model.ts`). Edge labels and cardinalities must not cover it.
 */
export function diagramGroupHeading(group: DiagramGroup): DiagramBox {
  if (group.scopeKind === "admin") return { x: group.x, y: group.y, width: group.width, height: 24 };
  return { x: group.x + 4, y: group.y - 7, width: Math.min(typeWidthBudget(group.label, "label") + 8, group.width - 8), height: 14 };
}
const EPS = 1e-7, RADIUS = 8, CLEARANCE = 24, PARALLEL = 12, LABEL_GAP = 8;
/** A crossing costs as much as 24 elbows: going around the outside beats a hop. */
const CROSSING_COST = 384;
/** Leaving an edge's geometric default side must buy more than an elbow. */
const SIDE_BIAS = 24;
/** Moving a port off its sorted slot must buy more than a few pixels. */
const SLOT_COST = 24;
/** A route keeps the same padding from a section outline as the outline keeps from its boxes. */
const GROUP_PAD = 16;
/** Everything painted keeps this distance from the image edge (maintainer ruling, 2026-11-03). */
export const DIAGRAM_MARGIN = 12;
/** True when a segment runs alongside a section outline closer than its padding. */
function hugsOutline(a: DiagramPoint, b: DiagramPoint, outlines: readonly DiagramBox[]): boolean {
  const vertical = Math.abs(a.x - b.x) < EPS;
  for (const o of outlines) {
    if (vertical) {
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      if (Math.min(hi, o.y + o.height) - Math.max(lo, o.y) <= GROUP_PAD) continue;
      if ([o.x, o.x + o.width].some(edge => Math.abs(a.x - edge) < GROUP_PAD - EPS)) return true;
    } else {
      const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
      if (Math.min(hi, o.x + o.width) - Math.max(lo, o.x) <= GROUP_PAD) continue;
      if ([o.y, o.y + o.height].some(edge => Math.abs(a.y - edge) < GROUP_PAD - EPS)) return true;
    }
  }
  return false;
}
const routeHugs = (points: DiagramPoint[], outlines: readonly DiagramBox[]) => points.slice(1).some((point, i) => hugsOutline(points[i]!, point, outlines));
/** Perpendicular intersections of one orthogonal segment with earlier routes. */
function crossCount(a: DiagramPoint, b: DiagramPoint, previous: readonly { points: DiagramPoint[] }[]): number {
  let count = 0; const h = Math.abs(a.y - b.y) < EPS;
  for (const route of previous) for (let j = 1; j < route.points.length; j++) {
    const c = route.points[j - 1]!, d = route.points[j]!;
    if (h === (Math.abs(c.y - d.y) < EPS)) continue;
    const [horizontal, vertical] = h ? [[a, b], [c, d]] : [[c, d], [a, b]];
    const hy = horizontal[0]!.y, vx = vertical[0]!.x;
    if (vx > Math.min(horizontal[0]!.x, horizontal[1]!.x) + EPS && vx < Math.max(horizontal[0]!.x, horizontal[1]!.x) - EPS
      && hy > Math.min(vertical[0]!.y, vertical[1]!.y) + EPS && hy < Math.max(vertical[0]!.y, vertical[1]!.y) - EPS) count++;
  }
  return count;
}
const routeCrossings = (points: DiagramPoint[], previous: readonly { points: DiagramPoint[] }[]) => points.slice(1).reduce((n, point, i) => n + crossCount(points[i]!, point, previous), 0);
/** Sides of `box` that face `other`, by centre. */
function facingSides(box: DiagramBox, other: DiagramBox): DiagramSide[] {
  const a = center(box), b = center(other), sides: DiagramSide[] = [];
  if (b.y > a.y + EPS) sides.push("bottom"); if (b.y < a.y - EPS) sides.push("top");
  if (b.x > a.x + EPS) sides.push("right"); if (b.x < a.x - EPS) sides.push("left");
  return sides;
}
function sidePort(box: DiagramBox, node: string, side: DiagramSide): DiagramPort {
  return { node, side, x: side === "left" ? box.x : side === "right" ? box.x + box.width : box.x + box.width / 2, y: side === "top" ? box.y : side === "bottom" ? box.y + box.height : box.y + box.height / 2 };
}
const frameSizes: Record<string, [number, number]> = { "doc-inline": [960, 600], "doc-wide": [1280, 720], "slide-16x9": [1280, 720], "slide-4x3": [1024, 768], "social-og": [1200, 632], "social-square": [1080, 1080], "print-a4-landscape": [1120, 792], "print-a3-landscape": [1584, 1120], "print-letter-landscape": [1056, 816] };
const equal = (a: DiagramPoint, b: DiagramPoint) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const distance = (a: DiagramPoint, b: DiagramPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const center = (box: DiagramBox): DiagramPoint => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const normal = (side: DiagramSide): DiagramPoint => ({ x: side === "left" ? -1 : side === "right" ? 1 : 0, y: side === "top" ? -1 : side === "bottom" ? 1 : 0 });
const overlaps = (a: DiagramBox, b: DiagramBox) => a.x < b.x + b.width - EPS && a.x + a.width > b.x + EPS && a.y < b.y + b.height - EPS && a.y + a.height > b.y + EPS;
const contains = (frame: DiagramBox, box: DiagramBox) => box.x >= frame.x - EPS && box.y >= frame.y - EPS && box.x + box.width <= frame.x + frame.width + EPS && box.y + box.height <= frame.y + frame.height + EPS;
/** Bound the emitted quarter arc between its two tangent points, not absent quadrants. */
function cornerBounds(previous: DiagramPoint, corner: DiagramPoint, next: DiagramPoint): DiagramBox {
  const before = distance(previous, corner), after = distance(corner, next);
  const start = { x: corner.x + (previous.x - corner.x) / before * RADIUS, y: corner.y + (previous.y - corner.y) / before * RADIUS };
  const end = { x: corner.x + (next.x - corner.x) / after * RADIUS, y: corner.y + (next.y - corner.y) / after * RADIUS };
  return { x: Math.min(start.x, end.x) - LABEL_GAP, y: Math.min(start.y, end.y) - LABEL_GAP,
    width: Math.abs(start.x - end.x) + 2 * LABEL_GAP, height: Math.abs(start.y - end.y) + 2 * LABEL_GAP };
}
function segmentHits(a: DiagramPoint, b: DiagramPoint, box: DiagramBox, padding = 0): boolean {
  const left = box.x - padding, right = box.x + box.width + padding, top = box.y - padding, bottom = box.y + box.height + padding;
  return Math.abs(a.y - b.y) < EPS ? a.y > top + EPS && a.y < bottom - EPS && Math.max(a.x, b.x) > left + EPS && Math.min(a.x, b.x) < right - EPS
    : a.x > left + EPS && a.x < right - EPS && Math.max(a.y, b.y) > top + EPS && Math.min(a.y, b.y) < bottom - EPS;
}
function normalize(points: DiagramPoint[]): DiagramPoint[] {
  const out: DiagramPoint[] = [];
  for (const point of points) {
    if (out.length && equal(out.at(-1)!, point)) continue;
    while (out.length >= 2) {
      const a = out.at(-2)!, b = out.at(-1)!;
      if ((Math.abs(a.x - b.x) < EPS && Math.abs(b.x - point.x) < EPS || Math.abs(a.y - b.y) < EPS && Math.abs(b.y - point.y) < EPS) && Math.abs(distance(a, point) - distance(a, b) - distance(b, point)) < EPS) out.pop();
      else break;
    }
    out.push(point);
  }
  return out;
}
function sidePair(a: DiagramBox, b: DiagramBox, self: boolean): [DiagramSide, DiagramSide] {
  if (self) return ["right", "top"];
  const ac = center(a), bc = center(b), horizontal = a.x + a.width <= b.x || b.x + b.width <= a.x;
  const vertical = a.y + a.height <= b.y || b.y + b.height <= a.y;
  if (horizontal && (!vertical || Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y))) return bc.x >= ac.x ? ["right", "left"] : ["left", "right"];
  return bc.y >= ac.y ? ["bottom", "top"] : ["top", "bottom"];
}
interface BoxRecord extends DiagramBox { id: string }
interface Pair { from: DiagramPort; to: DiagramPort; id: string }
function routeShape(points: DiagramPoint[], pair: Pair, frame: DiagramBox): boolean {
  if (points.length < 2) return false;
  const first = points[1]!, last = points.at(-2)!, fromNormal = normal(pair.from.side), toNormal = normal(pair.to.side);
  if ((first.x - pair.from.x) * fromNormal.x + (first.y - pair.from.y) * fromNormal.y <= EPS ||
    (last.x - pair.to.x) * toNormal.x + (last.y - pair.to.y) * toNormal.y <= EPS) return false;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (!contains(frame, { ...point, width: 0, height: 0 })) return false;
    if (i === 0) continue;
    const previous = points[i - 1]!;
    if (Math.abs(point.x - previous.x) > EPS && Math.abs(point.y - previous.y) > EPS) return false;
    if (points.length > 2 && distance(point, previous) + EPS < (i === 1 || i === points.length - 1 ? RADIUS : 2 * RADIUS)) return false;
    if (i > 1) {
      const before = points[i - 2]!;
      if (Math.abs(before.x - previous.x) < EPS && Math.abs(previous.x - point.x) < EPS || Math.abs(before.y - previous.y) < EPS && Math.abs(previous.y - point.y) < EPS) return false;
    }
  }
  return true;
}
function clearRoute(points: DiagramPoint[], pair: Pair, boxes: BoxRecord[]): boolean {
  for (let i = 1; i < points.length; i++) for (const box of boxes) {
    if (i === 1 && box.id === pair.from.node || i === points.length - 1 && box.id === pair.to.node) continue;
    if (segmentHits(points[i - 1]!, points[i]!, box, RADIUS)) return false;
  }
  return true;
}
interface Crossing extends DiagramPoint { segment: number; other: DiagramConnector; otherSegment: number }
function crossings(points: DiagramPoint[], previous: DiagramConnector[], partial = false): Crossing[] | null {
  const found: Crossing[] = [];
  for (let i = 1; i < points.length; i++) for (const other of previous) for (let j = 1; j < other.points.length; j++) {
    const a = points[i - 1]!, b = points[i]!, c = other.points[j - 1]!, d = other.points[j]!;
    const h = Math.abs(a.y - b.y) < EPS, oh = Math.abs(c.y - d.y) < EPS;
    if (h === oh) {
      const overlap = h ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) : Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
      const separation = h ? Math.abs(a.y - c.y) : Math.abs(a.x - c.x);
      if (overlap > EPS && separation + EPS < PARALLEL) return null;
      continue;
    }
    const p = { x: h ? c.x : a.x, y: h ? a.y : c.y };
    if (p.x < Math.min(a.x, b.x) - EPS || p.x > Math.max(a.x, b.x) + EPS || p.y < Math.min(a.y, b.y) - EPS || p.y > Math.max(a.y, b.y) + EPS || p.x < Math.min(c.x, d.x) - EPS || p.x > Math.max(c.x, d.x) + EPS || p.y < Math.min(c.y, d.y) - EPS || p.y > Math.max(c.y, d.y) + EPS) continue;
    // A hop must fit on straight runs, clear of corners, ports and other hops.
    if ([a, ...(partial && i === points.length - 1 ? [] : [b]), c, d].some(end => distance(end, p) < RADIUS + 6 - EPS) || found.some(item => distance(item, p) < 12 - EPS) || other.bridges.some(item => distance(item, p) < 14 - EPS)) return null;
    found.push({ ...p, segment: i - 1, other, otherSegment: j - 1 });
  }
  return found;
}
function comparePoints(a: DiagramPoint[], b: DiagramPoint[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const value = a[i]!.x - b[i]!.x || a[i]!.y - b[i]!.y; if (Math.abs(value) > EPS) return value; }
  return a.length - b.length;
}
function length(points: DiagramPoint[]) { return points.slice(1).reduce((total, point, i) => total + distance(points[i]!, point), 0); }
function routingPoints(pair: Pair, boxes: BoxRecord[], previous: DiagramConnector[], frame: DiagramBox, outside = false, crossingCost = 0, outlines: readonly DiagramBox[] = [], nest = false): DiagramPoint[] | null {
  const a = pair.from, b = pair.to, an = normal(a.side), bn = normal(b.side);
  const start = { x: a.x + an.x * CLEARANCE, y: a.y + an.y * CLEARANCE }, end = { x: b.x + bn.x * CLEARANCE, y: b.y + bn.y * CLEARANCE };
  const xs = new Set([start.x, end.x, (start.x + end.x) / 2, frame.x + CLEARANCE, frame.x + frame.width - CLEARANCE]);
  const ys = new Set([start.y, end.y, (start.y + end.y) / 2, frame.y + CLEARANCE, frame.y + frame.height - CLEARANCE]);
  for (const box of boxes) { xs.add(box.x - CLEARANCE); xs.add(box.x + box.width + CLEARANCE); ys.add(box.y - CLEARANCE); ys.add(box.y + box.height + CLEARANCE); }
  for (const o of outlines) { xs.add(o.x - GROUP_PAD); xs.add(o.x + o.width + GROUP_PAD); ys.add(o.y - GROUP_PAD); ys.add(o.y + o.height + GROUP_PAD); }
  for (const route of previous) for (const point of route.points) { xs.add(point.x - PARALLEL); xs.add(point.x + PARALLEL); ys.add(point.y - PARALLEL); ys.add(point.y + PARALLEL); }
  const xx = [...xs].filter(x => x >= frame.x && x <= frame.x + frame.width).sort((a, b) => a - b), yy = [...ys].filter(y => y >= frame.y && y <= frame.y + frame.height).sort((a, b) => a - b);
  if ((xx.length + yy.length) * 19 > 20_000) throw Error("routing exceeds its 20000-candidate work bound; split the diagram");
  const candidates: DiagramPoint[][] = [[a, b], [a, start, { x: end.x, y: start.y }, end, b], [a, start, { x: start.x, y: end.y }, end, b]];
  for (const x of xx) candidates.push([a, start, { x, y: start.y }, { x, y: end.y }, end, b]);
  for (const y of yy) candidates.push([a, start, { x: start.x, y }, { x: end.x, y }, end, b]);
  const preferredCount = candidates.length;
  // Short port stubs and open-canvas detours handle near-aligned fanned
  // ports whose offset is smaller than two 8px elbows.
  for (const ad of [8, 16, 24]) for (const bd of [8, 16, 24]) {
    const aa = { x: a.x + an.x * ad, y: a.y + an.y * ad }, bb = { x: b.x + bn.x * bd, y: b.y + bn.y * bd };
    for (const x of xx) candidates.push([a, aa, { x, y: aa.y }, { x, y: bb.y }, bb, b]);
    for (const y of yy) candidates.push([a, aa, { x: aa.x, y }, { x: bb.x, y }, bb, b]);
  }
  if (outside) {
    const x = Math.max(...boxes.map(box => box.x + box.width)) + CLEARANCE;
    if(x+8>frame.x+frame.width)return null;
    const cycle = normalize([a, { x, y: a.y }, { x, y: b.y }, b]);
    return routeShape(cycle, pair, frame) && clearRoute(cycle, pair, boxes) && crossings(cycle, previous) !== null ? cycle : null;
  }
  const normalized = candidates.map(normalize), preferred = new Set(normalized.slice(0, preferredCount));
  const valid = normalized.filter(points => routeShape(points, pair, frame) && clearRoute(points, pair, boxes) && !routeHugs(points, outlines) && crossings(points, previous) !== null);
  const cost = new Map(valid.map(points => [points, length(points) + points.length * 16 + routeCrossings(points, previous) * crossingCost]));
  // Nesting: when a sibling on this side still has to pass underneath, an equal-cost
  // route turns as early as it may so the sibling keeps the lane below it.
  const stub = (points: DiagramPoint[]) => distance(points[0]!, points[1]!);
  valid.sort((a, b) => cost.get(a)! - cost.get(b)! || (nest ? stub(a) - stub(b) : 0) || Number(preferred.has(b)) - Number(preferred.has(a)) || comparePoints(a, b));
  if (valid.length) return valid[0]!;
  // Sparse visibility search is bounded independently of editorial warnings.
  if (xx.length * yy.length > 20_000) throw Error("routing exceeds its 20000-vertex work bound; split the diagram");
  if (!contains(frame, { ...start, width: 0, height: 0 }) || !contains(frame, { ...end, width: 0, height: 0 })) return null;
  const startX = xx.indexOf(start.x), startY = yy.indexOf(start.y), endX = xx.indexOf(end.x), endY = yy.indexOf(end.y);
  interface State { x: number; y: number; direction: "h" | "v"; run: number; cost: number; path: DiagramPoint[] }
  const queue: State[] = [{ x: startX, y: startY, direction: an.x ? "h" : "v", run: 16, cost: 0, path: [a, start] }], best = new Map<string, number>();
  let work = 0;
  while (queue.length) {
    if (++work > 100_000) throw Error("routing exceeds its 100000-step work bound; split the diagram");
    queue.sort((a, b) => a.cost - b.cost); const current = queue.shift()!;
    const point = { x: xx[current.x]!, y: yy[current.y]! };
    if (current.x === endX && current.y === endY) {
      const points = normalize([...current.path, b]);
      if (routeShape(points, pair, frame) && clearRoute(points, pair, boxes) && !routeHugs(points, outlines) && crossings(points, previous) !== null) return points;
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const x = current.x + dx, y = current.y + dy; if (x < 0 || y < 0 || x >= xx.length || y >= yy.length) continue;
      const next = { x: xx[x]!, y: yy[y]! }, direction = dx ? "h" : "v", turn = direction !== current.direction;
      if (turn && current.run < 16 - EPS || boxes.some(box => segmentHits(point, next, box, RADIUS)) || hugsOutline(point, next, outlines)) continue;
      if (crossings(normalize([...current.path, next]), previous, true) === null) continue;
      const run = Math.min(16, turn ? distance(point, next) : current.run + distance(point, next)), cost = current.cost + distance(point, next) + (turn ? 32 : 0) + crossCount(point, next, previous) * crossingCost;
      const key = `${x}:${y}:${direction}:${run}`; if ((best.get(key) ?? Infinity) <= cost) continue;
      best.set(key, cost); queue.push({ x, y, direction, run, cost, path: normalize([...current.path, next]) });
    }
  }
  return null;
}
function pathData(route: DiagramConnector): string {
  const out = [`M ${route.points[0]!.x} ${route.points[0]!.y}`];
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]!, b = route.points[i]!, total = distance(a, b), dx = (b.x - a.x) / total, dy = (b.y - a.y) / total;
    for (const bridge of route.bridges.filter(item => item.segment === i - 1).sort((p, q) => distance(a, p) - distance(a, q))) {
      out.push(`L ${bridge.x - dx * 6} ${bridge.y - dy * 6}`, `A 6 6 0 0 1 ${bridge.x + dx * 6} ${bridge.y + dy * 6}`);
    }
    if (i === route.points.length - 1) { out.push(`L ${b.x} ${b.y}`); continue; }
    const c = route.points[i + 1]!, nextLength = distance(b, c), nx = (c.x - b.x) / nextLength, ny = (c.y - b.y) / nextLength;
    out.push(`L ${b.x - dx * RADIUS} ${b.y - dy * RADIUS}`, `A 8 8 0 0 ${dx * ny - dy * nx > 0 ? 1 : 0} ${b.x + nx * RADIUS} ${b.y + ny * RADIUS}`);
  }
  return out.join(" ");
}

/**
 * Pure neutral geometry for a semantically valid free-layout spec. No DOM or
 * paint. Routing adapts ports to the other ends and to earlier routes; a spec
 * that only the fixed geometric sides and declared port order can route keeps
 * that routing, so adaptation never refuses a spec that routed before.
 */
/** Hidden box transit, then hops: what a reader notices first in a routing. */
function crossingScore(tree: DiagramTree): [number, number] {
  const routes = tree.elements.filter((item): item is DiagramConnector => item.kind === "connector");
  return [routes.reduce((n, route) => n + route.transit.length, 0), routes.reduce((n, route) => n + route.bridges.length, 0)];
}
export function buildDiagram(input: DiagramSpec, options: DiagramGeometryOptions = {}): DiagramTree {
  // An edge that greedy routing boxes in is routed earlier and the layout is
  // rebuilt (rip-up and retry), at most once per edge.
  const priority: number[] = [];
  for (;;) {
    try {
      const adapted = buildDiagramWith(input, options, true, priority), score = crossingScore(adapted);
      if (score[0] === 0 && score[1] === 0) return adapted;
      // Never worse than the declared routing it replaces.
      const declared = buildDiagramWith(input, options, false, []), before = crossingScore(declared);
      return before[0] < score[0] || before[0] === score[0] && before[1] < score[1] ? declared : adapted;
    }
    catch (failure) {
      if (!(failure instanceof DiagramGeometryError)) throw failure;
      const edge = Number(/^\$\.edges\[(\d+)\]$/.exec(failure.findings[0]?.path ?? "")?.[1] ?? NaN);
      if (!Number.isInteger(edge) || priority.includes(edge)) return buildDiagramWith(input, options, false, []);
      priority.push(edge);
    }
  }
}
function buildDiagramWith(input: DiagramSpec, options: DiagramGeometryOptions, adaptive: boolean, priority: readonly number[]): DiagramTree {
  const spec = diagramSpecSchema.parse(input);
  if (["quadrant", "layer-stack", "pyramid", "funnel", "loop", "flywheel", "venn"].includes(spec.type)) return buildPositionalDiagram(spec);
  if ((AXIS_TYPES as readonly string[]).includes(spec.type)) return buildAxisDiagram(spec);
  if (!(FREE_LAYOUT_TYPES as readonly string[]).includes(spec.type)) throw new DiagramGeometryError([{ path: "$.type", code: "unroutable", message: `Geometry for '${spec.type}' belongs to its type family; free-layout routing is required here` }]);
  const fontSize = options.labelFontSize ?? 9.5, lineHeight = options.labelLineHeight ?? 12;
  if (![fontSize, lineHeight].every(value => Number.isFinite(value) && value >= 9 && value <= 256) || lineHeight < fontSize) throw Error("Label metrics require finite 9–256px dimensions and a line height at least the font size");
  const source = spec as Extract<DiagramSpec, { type: typeof FREE_LAYOUT_TYPES[number] }>;
  const focal = new Set([...(spec.focal ?? []), ...spec.nodes.filter(item => item.role === "focal").map(item => item.id)]);
  const nodes: DiagramNode[] = source.nodes.map(({ at, size, ...node }) => ({ ...node, nodeKind: "kind" in node ? node.kind : undefined, kind: "node", x: at[0], y: at[1], width: size[0], height: size[1], focal: focal.has(node.id) }));
  if (spec.type === "dependency") nodes.forEach(node => { node.fanIn = new Set(spec.edges.filter(edge => edge.to === node.id).map(edge=>edge.from)).size; });
  const boxes = new Map<string, BoxRecord>(nodes.map(node => [node.id, node]));
  const groups: DiagramGroup[] = (spec.groups ?? []).map(group => {
    const members = group.members.map(id => boxes.get(id));
    if (members.some(item => !item)) throw Error(`Group '${group.id}' has an unknown member`);
    const x = Math.min(...members.map(item => item!.x)) - 16, y = Math.min(...members.map(item => item!.y)) - 16;
    return { kind: "group", id: group.id, label: group.label, focal: focal.has(group.id), x, y, width: Math.max(...members.map(item => item!.x + item!.width)) + 16 - x, height: Math.max(...members.map(item => item!.y + item!.height)) + 16 - y };
  });
  if (spec.type === "architecture" && spec.containment) {
    groups.push(...spec.containment.scopes.map(scope=>({kind:"group" as const,id:scope.id,label:scope.label,scopeKind:scope.kind,parent:scope.parent,focal:focal.has(scope.id),x:scope.at[0],y:scope.at[1],width:scope.size[0],height:scope.size[1]})));
  }
  for (const group of groups) boxes.set(group.id, group);
  const groupBounds = groups.map(diagramGroupBounds);
  // A fitted frame keeps the routing margin on every side, so an outer lane
  // exists on the left and top exactly as it does on the right and bottom.
  const framed = [...nodes, ...groups.filter(group => group.scopeKind)];
  // Routing lanes need room only when there is something to route.
  const lanes = adaptive && spec.edges.length > 0, margin = lanes ? CLEARANCE : 0, pad = lanes ? GROUP_PAD : 0;
  const x = spec.size === "fit" ? Math.min(0, ...groupBounds.map(box => Math.floor((box.x - pad) / 4) * 4), ...(lanes ? framed.map(node => Math.floor((node.x - margin) / 4) * 4) : [])) : 0;
  const y = spec.size === "fit" ? Math.min(0, ...groupBounds.map(box => Math.floor((box.y - pad) / 4) * 4), ...(lanes ? framed.map(node => Math.floor((node.y - margin) / 4) * 4) : [])) : 0;
  // Section outlines a route must keep its padding from; containment scopes keep their own rules.
  const outlines: DiagramBox[] = adaptive ? groups.filter(group => !group.scopeKind).map(({ x, y, width, height }) => ({ x, y, width, height })) : [];
  const [right, bottom] = frameSizes[spec.size] ?? [Math.max(96, ...[...nodes, ...groups.filter(group => group.scopeKind)].map(node => node.x + node.width + CLEARANCE), ...groupBounds.map(box => box.x + box.width + pad)), Math.max(96, ...[...nodes, ...groups.filter(group => group.scopeKind)].map(node => node.y + node.height + CLEARANCE), ...groupBounds.map(box => box.y + box.height + pad))];
  const width = right - x + (spec.size === "fit" && spec.type === "dependency" && spec.edges.some(edge => edge.cycle) ? 24 : 0);
  const viewBox = { x, y, width, height: bottom - y };
  // Adaptive routes keep the image margin: a preset canvas is inset; a fitted frame is cropped around them afterwards.
  const routeFrame = adaptive && spec.size !== "fit" ? { x: viewBox.x + DIAGRAM_MARGIN, y: viewBox.y + DIAGRAM_MARGIN, width: viewBox.width - 2 * DIAGRAM_MARGIN, height: viewBox.height - 2 * DIAGRAM_MARGIN } : viewBox;
  if (spec.size !== "fit") {
    const findings: DiagramGeometryFinding[] = [];
    groups.forEach((group, index) => {
      if (!contains(viewBox, groupBounds[index]!)) findings.push({ path: group.scopeKind ? `$.containment.scopes[${index - (spec.groups?.length ?? 0)}]` : `$.groups[${index}]`, code: "scene_bounds", message: `Group '${group.id}' and its heading exceed the selected frame; move the group inward or use size: fit` });
    });
    if (findings.length) throw new DiagramGeometryError(findings);
  }
  const fail = (edge: number, message: string): never => { const item = spec.edges[edge]!; throw new DiagramGeometryError([{ path: `$.edges[${edge}]`, code: "unroutable", message: `Edge '${item.id ?? `${item.from} → ${item.to}`}': ${message}` }]); };
  const pairs: Pair[] = [], attachments = new Map<string, { edge: number; end: "from" | "to"; node: string; side: DiagramSide }[]>();
  const shapePorts=new Map<string,Set<DiagramSide>>();
  const obstaclesFor = (fromNode: string, toNode: string) => nodes.filter(node => !groups.some(group => (group.id === fromNode || group.id === toNode) && spec.groups?.find(item => item.id === group.id)?.members.includes(node.id)));
  const SHAPED = ["decision","merge","initial","final","start","end"];
  // Ports adapt to where the other end and the earlier routes are: each free
  // edge takes whichever facing side pair routes cheapest, crossings included.
  const provisional: { points: DiagramPoint[] }[] = [], probes = new Map<number, DiagramPoint[]>();
  const chooseSides = (edge: number, item: typeof spec.edges[number], from: DiagramBox, to: DiagramBox, geometric: [DiagramSide, DiagramSide]): [DiagramSide, DiagramSide] => {
    const options: [DiagramSide, DiagramSide][] = [geometric];
    for (const a of facingSides(from, to)) for (const b of facingSides(to, from)) if (a !== geometric[0] || b !== geometric[1]) options.push([a, b]);
    // Crossings first; the geometric default wins every tie, so only a pair
    // that avoids a crossing moves a port off the dominant flow.
    let chosen = geometric, chosenPoints: DiagramPoint[] | undefined, chosenCost: [number, number] = [Infinity, Infinity];
    for (const option of options) {
      let points: DiagramPoint[] | null = null;
      try { points = routingPoints({ from: sidePort(from, item.from, option[0]), to: sidePort(to, item.to, option[1]), id: "probe" }, obstaclesFor(item.from, item.to), [], routeFrame, false, 0, outlines); } catch { points = null; }
      if (!points) continue;
      const cost: [number, number] = [routeCrossings(points, provisional), option === geometric ? 0 : SIDE_BIAS + length(points) + points.length * 16];
      if (cost[0] < chosenCost[0] || cost[0] === chosenCost[0] && cost[1] < chosenCost[1] - EPS) { chosen = option; chosenPoints = points; chosenCost = cost; }
    }
    if (chosenPoints) { provisional.push({ points: chosenPoints }); probes.set(edge, chosenPoints); }
    return [...chosen];
  };
  for (let edge = 0; edge < spec.edges.length; edge++) {
    const item = spec.edges[edge]!, from = boxes.get(item.from), to = boxes.get(item.to);
    if (!from || !to) fail(edge, "an endpoint does not exist");
    if (!contains(viewBox, from!) || !contains(viewBox, to!)) fail(edge, "an endpoint is outside the selected canvas; move it or use size: fit");
    const sides: [DiagramSide, DiagramSide] = spec.type==="tree"&&(spec.hierarchy||spec.direction) ? spec.direction==="right"?["right","left"]:["bottom","top"] : "cycle" in item && item.cycle ? ["right", "right"] : item.from === item.to || [item.from, item.to].some(id => SHAPED.includes(nodes.find(node => node.id === id)?.shape ?? "")) ? sidePair(from!, to!, item.from === item.to) : adaptive ? chooseSides(edge, item, from!, to!, sidePair(from!, to!, false)) : sidePair(from!, to!, false);
    for(const [end,id] of [[0,item.from],[1,item.to]] as const){
      const shape=nodes.find(node=>node.id===id)?.shape;
      if(shape && ["decision","merge","initial","final","start","end"].includes(shape)){
        const used=shapePorts.get(id)??new Set<DiagramSide>(), order:DiagramSide[]=[sides[end],"top","right","bottom","left"],side=order.find(side=>!used.has(side));
        if(!side)fail(edge,"the shaped endpoint has no unused perpendicular cardinal port; split the junction");
        sides[end]=side!;used.add(side!);shapePorts.set(id,used);
      }
    }
    pairs.push({ from: { node: item.from, side: sides[0], x: 0, y: 0 }, to: { node: item.to, side: sides[1], x: 0, y: 0 }, id: item.id ?? `edge:${edge}` });
    for (const [end, side, node] of [["from", sides[0], item.from], ["to", sides[1], item.to]] as const) { const key = `${node}:${side}`; const list = attachments.get(key) ?? []; list.push({ edge, end, node, side }); attachments.set(key, list); }
  }
  // Fan each side's ports in the order of their far endpoints, so routes
  // sharing a side do not swap places and cross.
  const far = (attachment: { edge: number; end: "from" | "to" }) => boxes.get(attachment.end === "from" ? spec.edges[attachment.edge]!.to : spec.edges[attachment.edge]!.from)!;
  // The key is where the edge's probe route first heads along this side (an
  // outer lane sorts outermost), else the far end's centre.
  if (adaptive) for (const list of attachments.values()) list.sort((a, b) => {
    const vertical = a.side === "left" || a.side === "right";
    const key = (item: typeof a) => {
      const probe = probes.get(item.edge), points = probe && (item.end === "from" ? probe : [...probe].reverse()), turn = points?.[2] ?? points?.at(-1);
      const c = turn ?? center(far(item)); return vertical ? c.y : c.x;
    };
    const farKey = (item: typeof a) => { const c = center(far(item)); return vertical ? c.y : c.x; };
    return key(a) - key(b) || farKey(a) - farKey(b) || a.edge - b.edge;
  });
  const slots = new Map<string, { key: string; index: number }>();
  for (const list of attachments.values()) list.forEach((attachment, index) => {
    const box = boxes.get(attachment.node)!, vertical = attachment.side === "left" || attachment.side === "right", length = vertical ? box.height : box.width;
    const offset = length * (index + 1) / (list.length + 1), gap = length / (list.length + 1);
    const dot = nodes.some(node => node.id === attachment.node && ["merge", "initial", "final"].includes(node.shape ?? ""));
    if ((!dot && (offset < 8 - EPS || length - offset < 8 - EPS)) || list.length > 1 && gap < (length < 48 ? 8 : 12) - EPS) fail(attachment.edge, "the endpoint edge has no legal fanned port spacing (12px, or 8px below 48px)");
    const port = pairs[attachment.edge]![attachment.end]; port.x = vertical ? box.x + (attachment.side === "right" ? box.width : 0) : box.x + offset; port.y = vertical ? box.y + offset : box.y + (attachment.side === "bottom" ? box.height : 0);
    slots.set(`${attachment.edge}:${attachment.end}`, { key: `${attachment.node}:${attachment.side}`, index });
  });
  // Ports adapt while routing: the fanned slots of a side are fixed, but each
  // edge takes the free slot pair at its two ends that routes cheapest
  // against the routes already placed. Leaving sorted order costs a little.
  const slotPoints = new Map<string, DiagramPoint[]>(), taken = new Set<string>();
  for (const [id, slot] of slots) { const [edge, end] = id.split(":") as [string, "from" | "to"]; const port = pairs[Number(edge)]![end]; const list = slotPoints.get(slot.key) ?? []; list[slot.index] = { x: port.x, y: port.y }; slotPoints.set(slot.key, list); }
  const connectors: DiagramConnector[] = [];
  // Long routes go first, so the edges that must wrap around claim the outer slots.
  const probeLength = (edge: number) => { const probe = probes.get(edge); return probe ? length(probe) + probe.length * 16 : 0; };
  const rank = (edge: number) => { const index = priority.indexOf(edge); return index < 0 ? Infinity : index; };
  const order = [...spec.edges.keys()]; if (adaptive) order.sort((a, b) => rank(a) - rank(b) || probeLength(b) - probeLength(a) || a - b);
  for (const edge of order) {
    const pair = pairs[edge]!, item = spec.edges[edge]!;
    const obstacles = obstaclesFor(pair.from.node, pair.to.node);
    let chosenRoute: DiagramPoint[] | null | undefined;
    if (adaptive && !("cycle" in item && item.cycle)) {
      const ends = (["from", "to"] as const).map(end => { const slot = slots.get(`${edge}:${end}`)!; return { end, slot, free: slotPoints.get(slot.key)!.map((point, index) => ({ point, index })).filter(option => !taken.has(`${slot.key}:${option.index}`)) }; });
      let bestCost = Infinity, best: [number, number] | undefined; chosenRoute = undefined;
      for (const a of ends[0]!.free) for (const b of ends[1]!.free) {
        if (ends[0]!.slot.key === ends[1]!.slot.key && a.index === b.index) continue;
        const trial: Pair = { ...pair, from: { ...pair.from, ...a.point }, to: { ...pair.to, ...b.point } };
        let route: DiagramPoint[] | null = null;
        // Nest over unrouted siblings on the same side whose far ends lie the same way.
        const heading = Math.sign(center(boxes.get(item.to)!).x - a.point.x) || Math.sign(center(boxes.get(item.to)!).y - a.point.y);
        const nest = (attachments.get(ends[0]!.slot.key) ?? []).some(other => other.edge !== edge && !connectors.some(route => route.edge === other.edge)
          && Math.sign((pairs[other.edge]!.from.node === pair.from.node ? center(boxes.get(spec.edges[other.edge]!.to)!) : center(boxes.get(spec.edges[other.edge]!.from)!)).x - a.point.x) === heading);
        try { route = routingPoints(trial, obstacles, connectors, routeFrame, false, CROSSING_COST, outlines, nest); } catch { route = null; }
        if (!route) continue;
        const cost = length(route) + route.length * 16 + routeCrossings(route, connectors) * CROSSING_COST + (Math.abs(a.index - ends[0]!.slot.index) + Math.abs(b.index - ends[1]!.slot.index)) * SLOT_COST;
        if (cost < bestCost - EPS) { bestCost = cost; best = [a.index, b.index]; chosenRoute = route; }
      }
      if (best) for (const [i, end] of (["from", "to"] as const).entries()) {
        const slot = ends[i]!.slot, point = slotPoints.get(slot.key)![best[i]!]!;
        pair[end].x = point.x; pair[end].y = point.y; taken.add(`${slot.key}:${best[i]}`);
      }
    }
    let points: DiagramPoint[] | null;
    // The slot search already routed this edge with its nesting context; keep that route.
    if (chosenRoute) points = chosenRoute;
    else try { points = routingPoints(pair, obstacles, connectors, adaptive ? routeFrame : viewBox, "cycle" in item && item.cycle === true, adaptive ? CROSSING_COST : 0, adaptive ? outlines : []); } catch (error) { fail(edge, (error as Error).message); }
    let transit: string[] = [];
    if (!points!) {
      const direct = [pair.from, pair.to];
      transit = obstacles.filter(box => box.id !== pair.from.node && box.id !== pair.to.node && segmentHits(pair.from, pair.to, box)).map(box => box.id);
      if (!transit.length || !routeShape(direct, pair, viewBox) || crossings(direct, connectors) === null) fail(edge, "no legal orthogonal route fits; move boxes or split the diagram");
      // A route blocked only by earlier connectors is not unavoidable box transit.
      if (connectors.length && routingPoints(pair, obstacles, [], viewBox)) fail(edge, "earlier connectors prevent a legal clear route; reorder edges or split the diagram");
      points = direct;
    }
    const connector: DiagramConnector = { kind: "connector", id: pair.id, edge, from: pair.from, to: pair.to, points: points!, path: "", radius: 8, bridges: [], dashed: item.kind === "async" || transit.length > 0, transit };
    const priority = (index: number, route: DiagramConnector) => route.transit.length ? 0 : spec.edges[index]!.kind === "primary" ? 3 : route.dashed ? 1 : 2;
    for (const cross of crossings(points!, connectors)!) {
      const lower = priority(edge, connector) <= priority(cross.other.edge, cross.other) ? connector : cross.other;
      lower.bridges.push({ x: cross.x, y: cross.y, segment: lower === connector ? cross.segment : cross.otherSegment, radius: 6, over: lower === connector ? cross.other.id : connector.id });
    }
    connectors.push(connector);
  }
  connectors.sort((a, b) => a.edge - b.edge);
  const cardinalities: DiagramCardinality[] = [];
  if (spec.type === "er") for (const connector of connectors) {
    const edge = spec.edges[connector.edge]!;
    for (const end of ["from", "to"] as const) {
      const text = end === "from" ? edge.fromCardinality : edge.toCardinality; if (!text) continue;
      const port = connector[end], n = normal(port.side), width = Math.ceil((typeWidthBudget(text, "label") + 8) / 4) * 4;
      const box: DiagramCardinality = {kind:"cardinality",edge:connector.edge,end,text,width,height:16,x:n.x ? port.x + (n.x > 0 ? 12 : -12-width) : port.x+12,y:n.y ? port.y + (n.y>0?12:-28) : port.y-24};
      if (!contains(viewBox,box) || nodes.some(node=>overlaps(box,node)) || cardinalities.some(other=>overlaps(box,other)) || groups.some(group=>overlaps(box,diagramGroupHeading(group))) || connectors.some(route=>route.points.slice(1).some((point,index)=>segmentHits(route.points[index]!,point,box,LABEL_GAP)) || route.bridges.some(bridge=>overlaps(box,{x:bridge.x-14,y:bridge.y-14,width:28,height:28})) || route.points.slice(1,-1).some((corner,index)=>overlaps(box,cornerBounds(route.points[index]!,corner,route.points[index+2]!))))) fail(connector.edge,"cardinality has no readable endpoint clearance; move nodes");
      cardinalities.push(box);
    }
  }
  const masks: DiagramLabelMask[] = [], labels: DiagramEdgeLabel[] = [];
  for (const connector of connectors) {
    connector.path = pathData(connector);
    const text = spec.edges[connector.edge]!.label; if (!text) continue;
    const width = Math.ceil((typeWidthBudget(text, "label", fontSize) + 8) / 4) * 4, height = Math.ceil((lineHeight + 4) / 4) * 4;
    const candidates: DiagramLabelMask[] = [];
    for (let segment = 0; segment < connector.points.length - 1; segment++) {
      const a = connector.points[segment]!, b = connector.points[segment + 1]!, horizontal = Math.abs(a.y - b.y) < EPS;
      if (connector.transit.length && segment !== 0) continue;
      const extent = horizontal ? width : height, start = horizontal ? a.x : a.y, end = horizontal ? b.x : b.y, direction = Math.sign(end - start);
      const centers = connector.transit.length ? [start + direction * (extent / 2 + 8)] : [(start + end) / 2, start + direction * (extent / 2 + 8), end - direction * (extent / 2 + 8)];
      for (const middle of centers) for (const side of [-1, 1]) {
        if (middle - extent / 2 < Math.min(start, end) - EPS || middle + extent / 2 > Math.max(start, end) + EPS) continue;
        const x = horizontal ? middle - width / 2 : side < 0 ? a.x - LABEL_GAP - width : a.x + LABEL_GAP, y = horizontal ? side < 0 ? a.y - LABEL_GAP - height : a.y + LABEL_GAP : middle - height / 2;
        candidates.push({ kind: "label-mask", edge: connector.edge, opaque: true, gap: 8, segment, x, y, width, height });
      }
    }
    const mask = candidates.find(candidate => contains(viewBox, candidate) && !nodes.some(node => overlaps(candidate, node)) && !masks.some(mask => overlaps(candidate, mask)) && !cardinalities.some(label => overlaps(candidate,label)) && !groups.some(group => overlaps(candidate, diagramGroupHeading(group))) && !connectors.some(route => route.points.slice(1).some((point, i) => segmentHits(route.points[i]!, point, candidate, LABEL_GAP)) ||
      route.bridges.some(bridge => overlaps(candidate, { x: bridge.x - 6 - LABEL_GAP, y: bridge.y - 6 - LABEL_GAP, width: 12 + 2 * LABEL_GAP, height: 12 + 2 * LABEL_GAP })) ||
      route.points.slice(1, -1).some((corner, index) => overlaps(candidate, cornerBounds(route.points[index]!, corner, route.points[index + 2]!)))));
    if (!mask) fail(connector.edge, "the label has no opaque open-canvas mask with an 8px connector gap; move boxes or shorten the label");
    masks.push(mask!); labels.push({ kind: "edge-label", edge: connector.edge, text, fontSize, x: mask!.x, y: mask!.y, width, height });
  }
  // A fitted image is everything painted plus one uniform margin, on the 4px grid.
  if (spec.size === "fit") {
    const painted: DiagramBox[] = [...groups.map(diagramGroupBounds), ...nodes, ...masks, ...labels, ...cardinalities,
      ...connectors.flatMap(route => route.points.map(point => ({ x: point.x, y: point.y, width: 0, height: 0 })))];
    if (painted.length) {
      // The margin is exact on the top and left; only the size rounds up to the grid.
      const left = Math.min(...painted.map(box => box.x)) - DIAGRAM_MARGIN, top = Math.min(...painted.map(box => box.y)) - DIAGRAM_MARGIN;
      const width = Math.ceil((Math.max(...painted.map(box => box.x + box.width)) + DIAGRAM_MARGIN - left - EPS) / 4) * 4;
      const height = Math.ceil((Math.max(...painted.map(box => box.y + box.height)) + DIAGRAM_MARGIN - top - EPS) / 4) * 4;
      // Callouts are planned later in the space authors leave around their boxes:
      // keep the reserved frame and only extend it where the margin is short.
      if (spec.callouts?.length) {
        const x0 = Math.min(viewBox.x, left), y0 = Math.min(viewBox.y, top);
        Object.assign(viewBox, { x: x0, y: y0, width: Math.ceil((Math.max(viewBox.x + viewBox.width, left + width) - x0 - EPS) / 4) * 4, height: Math.ceil((Math.max(viewBox.y + viewBox.height, top + height) - y0 - EPS) / 4) * 4 });
      } else Object.assign(viewBox, { x: left, y: top, width, height });
    }
  }
  return { schema_version: 1, type: spec.type, grammar: spec.type === "architecture" && spec.containment ? "architecture-containment" : undefined, title: spec.title, desc: spec.desc, viewBox, elements: [...groups, ...connectors, ...masks, ...labels, ...cardinalities, ...nodes] };
}
