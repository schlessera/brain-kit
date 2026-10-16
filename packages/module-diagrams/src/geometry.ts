import { typeWidthBudget } from "./skin.js";
import { diagramSpecSchema, FREE_LAYOUT_TYPES, type DiagramSpec } from "./spec.js";

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
export interface DiagramNode extends DiagramBox { kind: "node"; id: string; label: string; focal: boolean; sub?: string; tag?: string; role?: string; link?: string }
export interface DiagramGroup extends DiagramBox { kind: "group"; id: string; label: string; focal: boolean }
export type DiagramElement = DiagramConnector | DiagramLabelMask | DiagramEdgeLabel | DiagramNode | DiagramGroup;
export interface DiagramTree { schema_version: 1; type: DiagramSpec["type"]; title: string; desc: string; viewBox: DiagramBox; elements: DiagramElement[] }
export interface DiagramGeometryOptions { labelFontSize?: number; labelLineHeight?: number }
export interface DiagramGeometryFinding { path: string; code: "unroutable"; message: string }
export class DiagramGeometryError extends Error {
  readonly findings: DiagramGeometryFinding[];
  constructor(findings: DiagramGeometryFinding[]) { super(findings.map(item => item.message).join("; ")); this.name = "DiagramGeometryError"; this.findings = findings; }
}
const EPS = 1e-7, RADIUS = 8, CLEARANCE = 24, PARALLEL = 12, LABEL_GAP = 8;
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
function routingPoints(pair: Pair, boxes: BoxRecord[], previous: DiagramConnector[], frame: DiagramBox): DiagramPoint[] | null {
  const a = pair.from, b = pair.to, an = normal(a.side), bn = normal(b.side);
  const start = { x: a.x + an.x * CLEARANCE, y: a.y + an.y * CLEARANCE }, end = { x: b.x + bn.x * CLEARANCE, y: b.y + bn.y * CLEARANCE };
  const xs = new Set([start.x, end.x, (start.x + end.x) / 2, frame.x + CLEARANCE, frame.x + frame.width - CLEARANCE]);
  const ys = new Set([start.y, end.y, (start.y + end.y) / 2, frame.y + CLEARANCE, frame.y + frame.height - CLEARANCE]);
  for (const box of boxes) { xs.add(box.x - CLEARANCE); xs.add(box.x + box.width + CLEARANCE); ys.add(box.y - CLEARANCE); ys.add(box.y + box.height + CLEARANCE); }
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
  const normalized = candidates.map(normalize), preferred = new Set(normalized.slice(0, preferredCount));
  const valid = normalized.filter(points => routeShape(points, pair, frame) && clearRoute(points, pair, boxes) && crossings(points, previous) !== null);
  valid.sort((a, b) => length(a) + a.length * 16 - length(b) - b.length * 16 || Number(preferred.has(b)) - Number(preferred.has(a)) || comparePoints(a, b));
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
      if (routeShape(points, pair, frame) && clearRoute(points, pair, boxes) && crossings(points, previous) !== null) return points;
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const x = current.x + dx, y = current.y + dy; if (x < 0 || y < 0 || x >= xx.length || y >= yy.length) continue;
      const next = { x: xx[x]!, y: yy[y]! }, direction = dx ? "h" : "v", turn = direction !== current.direction;
      if (turn && current.run < 16 - EPS || boxes.some(box => segmentHits(point, next, box, RADIUS))) continue;
      if (crossings(normalize([...current.path, next]), previous, true) === null) continue;
      const run = Math.min(16, turn ? distance(point, next) : current.run + distance(point, next)), cost = current.cost + distance(point, next) + (turn ? 32 : 0);
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

/** Pure neutral geometry for a semantically valid free-layout spec. No DOM or paint. */
export function buildDiagram(input: DiagramSpec, options: DiagramGeometryOptions = {}): DiagramTree {
  const spec = diagramSpecSchema.parse(input);
  if (!(FREE_LAYOUT_TYPES as readonly string[]).includes(spec.type)) throw new DiagramGeometryError([{ path: "$.type", code: "unroutable", message: `Geometry for '${spec.type}' belongs to its type family; free-layout routing is required here` }]);
  const fontSize = options.labelFontSize ?? 9.5, lineHeight = options.labelLineHeight ?? 12;
  if (![fontSize, lineHeight].every(value => Number.isFinite(value) && value >= 9 && value <= 256) || lineHeight < fontSize) throw Error("Label metrics require finite 9–256px dimensions and a line height at least the font size");
  const source = spec as Extract<DiagramSpec, { type: typeof FREE_LAYOUT_TYPES[number] }>;
  const focal = new Set([...(spec.focal ?? []), ...spec.nodes.filter(item => item.role === "focal").map(item => item.id)]);
  const nodes: DiagramNode[] = source.nodes.map(({ at, size, ...node }) => ({ ...node, kind: "node", x: at[0], y: at[1], width: size[0], height: size[1], focal: focal.has(node.id) }));
  const boxes = new Map<string, BoxRecord>(nodes.map(node => [node.id, node]));
  const groups: DiagramGroup[] = (spec.groups ?? []).map(group => {
    const members = group.members.map(id => boxes.get(id));
    if (members.some(item => !item)) throw Error(`Group '${group.id}' has an unknown member`);
    const x = Math.min(...members.map(item => item!.x)) - 16, y = Math.min(...members.map(item => item!.y)) - 16;
    return { kind: "group", id: group.id, label: group.label, focal: focal.has(group.id), x, y, width: Math.max(...members.map(item => item!.x + item!.width)) + 16 - x, height: Math.max(...members.map(item => item!.y + item!.height)) + 16 - y };
  });
  for (const group of groups) boxes.set(group.id, group);
  const [width, height] = frameSizes[spec.size] ?? [Math.max(96, ...nodes.map(node => node.x + node.width + CLEARANCE)), Math.max(96, ...nodes.map(node => node.y + node.height + CLEARANCE))];
  const viewBox = { x: 0, y: 0, width, height };
  const fail = (edge: number, message: string): never => { const item = spec.edges[edge]!; throw new DiagramGeometryError([{ path: `$.edges[${edge}]`, code: "unroutable", message: `Edge '${item.id ?? `${item.from} → ${item.to}`}': ${message}` }]); };
  const pairs: Pair[] = [], attachments = new Map<string, { edge: number; end: "from" | "to"; node: string; side: DiagramSide }[]>();
  for (let edge = 0; edge < spec.edges.length; edge++) {
    const item = spec.edges[edge]!, from = boxes.get(item.from), to = boxes.get(item.to);
    if (!from || !to) fail(edge, "an endpoint does not exist");
    if (!contains(viewBox, from!) || !contains(viewBox, to!)) fail(edge, "an endpoint is outside the selected canvas; move it or use size: fit");
    const sides = sidePair(from!, to!, item.from === item.to);
    pairs.push({ from: { node: item.from, side: sides[0], x: 0, y: 0 }, to: { node: item.to, side: sides[1], x: 0, y: 0 }, id: item.id ?? `edge:${edge}` });
    for (const [end, side, node] of [["from", sides[0], item.from], ["to", sides[1], item.to]] as const) { const key = `${node}:${side}`; const list = attachments.get(key) ?? []; list.push({ edge, end, node, side }); attachments.set(key, list); }
  }
  for (const list of attachments.values()) list.forEach((attachment, index) => {
    const box = boxes.get(attachment.node)!, vertical = attachment.side === "left" || attachment.side === "right", length = vertical ? box.height : box.width;
    const offset = length * (index + 1) / (list.length + 1), gap = length / (list.length + 1);
    if (offset < 8 - EPS || length - offset < 8 - EPS || list.length > 1 && gap < (length < 48 ? 8 : 12) - EPS) fail(attachment.edge, "the endpoint edge has no legal fanned port spacing (12px, or 8px below 48px)");
    const port = pairs[attachment.edge]![attachment.end]; port.x = vertical ? box.x + (attachment.side === "right" ? box.width : 0) : box.x + offset; port.y = vertical ? box.y + offset : box.y + (attachment.side === "bottom" ? box.height : 0);
  });
  const connectors: DiagramConnector[] = [];
  for (let edge = 0; edge < spec.edges.length; edge++) {
    const pair = pairs[edge]!, item = spec.edges[edge]!;
    const obstacles = nodes.filter(node => !groups.some(group => (group.id === pair.from.node || group.id === pair.to.node) && spec.groups!.find(item => item.id === group.id)!.members.includes(node.id)));
    let points: DiagramPoint[] | null;
    try { points = routingPoints(pair, obstacles, connectors, viewBox); } catch (error) { fail(edge, (error as Error).message); }
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
    const mask = candidates.find(candidate => contains(viewBox, candidate) && !nodes.some(node => overlaps(candidate, node)) && !masks.some(mask => overlaps(candidate, mask)) && !connectors.some(route => route.points.slice(1).some((point, i) => segmentHits(route.points[i]!, point, candidate, LABEL_GAP)) ||
      route.bridges.some(bridge => overlaps(candidate, { x: bridge.x - 6 - LABEL_GAP, y: bridge.y - 6 - LABEL_GAP, width: 12 + 2 * LABEL_GAP, height: 12 + 2 * LABEL_GAP })) ||
      route.points.slice(1, -1).some((corner, index) => overlaps(candidate, cornerBounds(route.points[index]!, corner, route.points[index + 2]!)))));
    if (!mask) fail(connector.edge, "the label has no opaque open-canvas mask with an 8px connector gap; move boxes or shorten the label");
    masks.push(mask!); labels.push({ kind: "edge-label", edge: connector.edge, text, fontSize, x: mask!.x, y: mask!.y, width, height });
  }
  return { schema_version: 1, type: spec.type, title: spec.title, desc: spec.desc, viewBox, elements: [...groups, ...connectors, ...masks, ...labels, ...nodes] };
}
