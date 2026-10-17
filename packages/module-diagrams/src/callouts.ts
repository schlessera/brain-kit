import { calloutPathPoints, pointAlongCalloutPath } from "./callout-path.js";
import type { DiagramBox, DiagramElement, DiagramPoint, DiagramTree } from "./geometry.js";
import { nodeLinkSvg } from "./node-link-svg.js";
import type { DiagramSpec } from "./spec.js";
import { typeWidthBudget } from "./skin.js";

export type CalloutSide = "below" | "above" | "right" | "left";
export interface CalloutPlacement {
  index: number;
  target: string;
  name: string;
  text: string;
  placement: CalloutSide | "band";
  box: DiagramBox;
  lines: string[];
  anchor?: DiagramPoint;
  end?: DiagramPoint;
  column?: number;
  indexX?: number;
}
export interface CalloutGroup {
  target: string;
  name: string;
  indices: number[];
  drawn: "true" | "false" | "unmarked";
  explanation?: string;
  key?: number;
  cue?: DiagramBox;
  headers: Array<{ x: number; y: number; width: number; offset: number; lines: string[]; explanation: string[] }>;
}
export interface CalloutPlan {
  placements: CalloutPlacement[];
  groups: CalloutGroup[];
  bandTop: number;
  bandHeight: number;
  columns: number;
  contentBottom: number;
  errors: Array<{ path: string; code: "callout_room"; message: string }>;
}
const sides: CalloutSide[] = ["below", "above", "right", "left"];
const pad = (box: DiagramBox, n: number): DiagramBox => ({ x: box.x - n, y: box.y - n, width: box.width + 2 * n, height: box.height + 2 * n });
const overlaps = (a: DiagramBox, b: DiagramBox) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
const bounds = (a: DiagramPoint, b: DiagramPoint): DiagramBox => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
const pointDistance = (point: DiagramPoint, box: DiagramBox) => Math.hypot(Math.max(box.x - point.x, 0, point.x - box.x - box.width), Math.max(box.y - point.y, 0, point.y - box.y - box.height));

/** Conservative word wrapping shared by drawing and summary metadata. Never cuts a word. */
function wrapWords(value: string, measure: number, role: "note" | "label"): { lines: string[]; width: number; height: number } {
  const width = (line: string) => typeWidthBudget(role === "label" ? line.toUpperCase() : line, role);
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && width(`${line} ${word}`) > measure) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return { lines, width: Math.max(1, ...lines.map(width)), height: lines.length * 14 };
}
export function wrapCallout(value: string, measure = 168) { return wrapWords(value, measure, "note"); }
export function calloutTargetName(spec: DiagramSpec, target: string): string {
  const node = spec.nodes.find(item => item.id === target);
  if (node) return node.label;
  const group = spec.groups?.find(item => item.id === target);
  if (group) return group.label;
  if (spec.type === "architecture") {
    const scope = spec.containment?.scopes.find(item => item.id === target);
    if (scope) return scope.label;
  }
  const edge = spec.edges.find(item => item.id === target);
  return edge?.label ?? (edge ? `${spec.nodes.find(node => node.id === edge.from)?.label ?? edge.from} to ${spec.nodes.find(node => node.id === edge.to)?.label ?? edge.to}` : target);
}
export function groupCallouts(spec: DiagramSpec): Array<{ target: string; name: string; indices: number[] }> {
  const groups = new Map<string, { target: string; name: string; indices: number[] }>();
  spec.callouts?.forEach((note, index) => {
    const group = groups.get(note.target) ?? { target: note.target, name: calloutTargetName(spec, note.target), indices: [] };
    group.indices.push(index);
    groups.set(note.target, group);
  });
  return [...groups.values()];
}
export function undrawnCalloutExplanation(spec: DiagramSpec, target: string): string {
  const kind = spec.edges.some(edge => edge.id === target) ? "connectors" : spec.groups?.some(group => group.id === target) ? "groups" : spec.type === "architecture" && spec.containment?.scopes.some(scope => scope.id === target) ? "scopes" : "nodes";
  return `Not drawn: ${spec.type} diagrams don’t draw ${kind}.`;
}
export const calloutKeyWidth = (key: number) => Math.max(16, Math.ceil(typeWidthBudget(String(key), "label")) + 11);
interface Segment { a: DiagramPoint; b: DiagramPoint; owner: DiagramElement }
interface Obstacle { box: DiagramBox; owner: DiagramElement; text?: boolean }

/** Readable annotations only: authored nodes and routed connectors never move. */
export function planCallouts(spec: DiagramSpec, tree: DiagramTree, footerHeight: number, grow = spec.size === "fit"): CalloutPlan {
  const frame = { ...tree.viewBox };
  if (!spec.callouts?.length) return { placements: [], groups: [], bandTop: 0, bandHeight: 0, columns: 1, contentBottom: 0, errors: [] };
  // A default fit canvas can widen for an indivisible word. An authored 320px
  // drawing instead uses its existing summary fallback if the word cannot fit.
  if (grow && frame.width !== 320) {
    let longest = 0;
    for (const note of spec.callouts) for (const word of note.text.split(/\s+/)) longest = Math.max(longest, typeWidthBudget(word, "note"));
    const notes = spec.callouts?.length ?? 0, indexWidth = Math.max(24, typeWidthBudget(String(notes), "label"));
    let heading = 0;
    for (const group of groupCallouts(spec)) for (const word of group.name.split(/\s+/)) heading = Math.max(heading, typeWidthBudget(word.toUpperCase(), "label") + calloutKeyWidth(notes) + 10);
    const measure = Math.max(longest + indexWidth + 8, heading);
    const required = notes > 1 ? 2 * measure + 56 : measure + 32;
    frame.width = Math.max(frame.width, Math.ceil(required / 4) * 4);
  }
  const obstacles: Obstacle[] = [], segments: Segment[] = [];
  const nodes = tree.elements.filter(item => item.kind === "node");
  const groups = tree.elements.filter(item => item.kind === "group");
  const addSegments = (points: DiagramPoint[], owner: DiagramElement) => points.slice(1).forEach((point, index) => segments.push({ a: points[index]!, b: point, owner }));
  for (const item of tree.elements) {
    if (item.kind === "connector") {
      addSegments(calloutPathPoints(item.path), item);
      const tip = item.points.at(-1)!, before = item.points.at(-2)!;
      const length = Math.hypot(tip.x - before.x, tip.y - before.y), dx = (tip.x - before.x) / length, dy = (tip.y - before.y) / length;
      if (spec.type !== "tree" && spec.type !== "er") addSegments([{ x: tip.x - dx * 7 - dy * 4, y: tip.y - dy * 7 + dx * 4 }, tip, { x: tip.x - dx * 7 + dy * 4, y: tip.y - dy * 7 - dx * 4 }], item);
    } else if (item.kind === "group") {
      obstacles.push({ box: { x: item.x + 4, y: item.y - 7, width: typeWidthBudget(item.label, "label") + 8, height: item.scopeKind === "admin" ? 31 : 14 }, owner: item, text: true });
    } else if (item.kind === "shape" && (item.shape === "line" || item.shape === "path")) {
      addSegments(item.shape === "line" ? [{ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 }] : calloutPathPoints(item.d), item);
      if (item.arrow) {
        const { x, y, dx, dy } = item.arrow;
        addSegments([{ x: x - dx * 7 - dy * 4, y: y - dy * 7 + dx * 4 }, { x, y }, { x: x - dx * 7 + dy * 4, y: y - dy * 7 - dx * 4 }], item);
      }
    } else if (!(item.kind === "shape" && (item.paint === "zone" || item.paint === "cluster"))) {
      obstacles.push({ box: item, owner: item, text: item.kind === "shape" && item.shape === "text" });
    }
    if (item.kind === "node") {
      for (const part of nodeLinkSvg(item, spec)) if (part.tag === "text") {
        const font = Number(part.attrs["font-size"]), value = part.text ?? "";
        // Width budgets are conservative; ascent plus descender stays inside
        // this role-sized box rather than the entire authored node rectangle.
        const width = typeWidthBudget(value, "name", font), align = part.attrs["text-anchor"];
        const left = Number(part.attrs.x) - (align === "middle" ? width / 2 : align === "end" ? width : 0);
        obstacles.push({ box: { x: left, y: Number(part.attrs.y) - font, width, height: font + 3 }, owner: item, text: true });
      }
    }
  }
  const targetFor = (target: string): Exclude<DiagramElement, { kind: "connector" }> | undefined => nodes.find(item => item.id === target) ?? groups.find(item => item.id === target) ?? tree.elements.find((item): item is Extract<DiagramElement, { kind: "shape" }> => item.kind === "shape" && item.nodeId === target && item.shape !== "text");
  const owns = (item: DiagramElement, target: string) => {
    if (item.kind === "connector") return spec.edges[item.edge]?.id === target;
    if (item.kind === "shape") {
      if (item.nodeId === target) return true;
      const edge = spec.edges.find(edge => edge.id === target);
      return !!edge && item.edgeId === target && item.from === edge.from && item.to === edge.to;
    }
    return (item.kind === "node" || item.kind === "group") && item.id === target;
  };
  const routesFor = (target: string) => tree.elements.flatMap<{ owner: DiagramElement; points: DiagramPoint[] }>(item => item.kind === "connector" && owns(item, target) ? [{ owner: item, points: calloutPathPoints(item.path) }] : item.kind === "shape" && owns(item, target) && (item.shape === "line" || item.shape === "path") ? [{ owner: item, points: item.shape === "line" ? [{ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 }] : calloutPathPoints(item.d) }] : []);
  const drawn = (target: string) => !!targetFor(target) || routesFor(target).length > 0;
  const initialBottom = Math.max(0, ...tree.elements.map(item => item.kind === "connector" ? Math.max(...item.points.map(point => point.y)) : item.y + item.height));
  let contentBottom = initialBottom;
  const placed: CalloutPlacement[] = [];
  const within = (box: DiagramBox) => box.x >= 8 && box.x + box.width <= frame.width - 8 && box.y >= 8 && (grow || box.y + box.height <= frame.height - footerHeight - 8);
  function boundary(target: string, side: CalloutSide): DiagramPoint | undefined {
    const box = targetFor(target);
    if (!box) return;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const dx = side === "left" ? -1 : side === "right" ? 1 : 0, dy = side === "above" ? -1 : side === "below" ? 1 : 0;
    if (box.kind === "node" && ["initial", "final", "merge"].includes(box.shape ?? "")) {
      const radius = box.shape === "initial" ? 6 : box.shape === "final" ? 8 : 4;
      return { x: cx + dx * radius, y: cy + dy * radius };
    }
    const polygon = box.kind === "shape" && box.shape === "polygon" ? box.points : box.kind === "node" && box.shape === "decision" ? [{ x: cx, y: box.y }, { x: box.x + box.width, y: cy }, { x: cx, y: box.y + box.height }, { x: box.x, y: cy }] : undefined;
    if (polygon) for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, vx = b.x - a.x, vy = b.y - a.y, den = dx * vy - dy * vx;
      if (Math.abs(den) < 1e-8) continue;
      const t = ((a.x - cx) * vy - (a.y - cy) * vx) / den, u = ((a.x - cx) * dy - (a.y - cy) * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1) return { x: cx + dx * t, y: cy + dy * t };
    }
    return { x: cx + dx * box.width / 2, y: cy + dy * box.height / 2 };
  }
  function anchors(target: string, side: CalloutSide): DiagramPoint[] {
    const border = boundary(target, side);
    if (border) return [border];
    return routesFor(target).flatMap(route => [0.25, 0.75].flatMap(fraction => {
      const point = pointAlongCalloutPath(route.points, fraction);
      return point && pointDistance(point, bounds(route.points[0]!, route.points[0]!)) >= 8 && pointDistance(point, bounds(route.points.at(-1)!, route.points.at(-1)!)) >= 8 && !obstacles.some(obstacle => (obstacle.owner.kind === "label-mask" || obstacle.owner.kind === "cardinality" || obstacle.text) && pointDistance(point, obstacle.box) < 8) ? [point] : [];
    }));
  }
  function inline(index: number): CalloutPlacement | undefined {
    const note = spec.callouts![index]!, order = note.side ? [note.side, ...sides.filter(side => side !== note.side)] : sides;
    for (const side of order) for (const anchor of anchors(note.target, side)) {
      for (const measure of [168, 112, 80]) for (const gap of [16, 24, 10]) for (const slide of [0, -0.5, 0.5]) {
        const wrapped = wrapCallout(note.text, measure), vertical = side === "below" || side === "above";
        const box = { x: vertical ? anchor.x - wrapped.width / 2 + slide * wrapped.width : side === "right" ? anchor.x + gap : anchor.x - gap - wrapped.width, y: vertical ? side === "below" ? anchor.y + gap : anchor.y - gap - wrapped.height : anchor.y - wrapped.height / 2 + slide * wrapped.height, width: wrapped.width, height: wrapped.height };
        const end = vertical ? { x: anchor.x, y: side === "below" ? box.y - 2 : box.y + box.height + 2 } : { x: side === "right" ? box.x - 2 : box.x + box.width + 2, y: anchor.y };
        if (!within(pad(box, 4)) || obstacles.some(obstacle => overlaps(pad(box, 4), obstacle.box)) || segments.some(segment => overlaps(pad(box, 5), bounds(segment.a, segment.b)))) continue;
        if (groups.some(group => overlaps(pad(box, 4), group) && !(box.x - 4 >= group.x && box.y - 4 >= group.y && box.x + box.width + 4 <= group.x + group.width && box.y + box.height + 4 <= group.y + group.height))) continue;
        if (placed.some(other => overlaps(pad(box, 4), other.box) || other.end && overlaps(pad(box, 4), pad(bounds(other.anchor!, other.end), 1)))) continue;
        const leader = pad(bounds(anchor, end), 1);
        if (obstacles.some(obstacle => !(owns(obstacle.owner, note.target) && !obstacle.text) && overlaps(leader, obstacle.box)) || placed.some(other => overlaps(leader, pad(other.box, 4)) || other.end && overlaps(leader, pad(bounds(other.anchor!, other.end), 1)))) continue;
        if (segments.some(segment => {
          if (!overlaps(leader, bounds(segment.a, segment.b))) return false;
          if (!owns(segment.owner, note.target) || pointDistance(anchor, bounds(segment.a, segment.b)) > 0.01) return true;
          // A leader may leave its own connector at a right angle, but may
          // neither run over it nor touch a different part of the same path.
          return Math.abs((segment.b.x - segment.a.x) * (end.y - anchor.y) - (segment.b.y - segment.a.y) * (end.x - anchor.x)) < 0.01;
        })) continue;
        return { index, target: note.target, name: calloutTargetName(spec, note.target), text: note.text, placement: side, box, lines: wrapped.lines, anchor, end };
      }
    }
  }
  const targetGroups = groupCallouts(spec), bandGroups: CalloutGroup[] = [];
  for (const group of targetGroups) {
    const note = group.indices.length === 1 ? inline(group.indices[0]!) : undefined;
    if (note) { placed.push(note); contentBottom = Math.max(contentBottom, note.box.y + note.box.height); }
    else bandGroups.push({ ...group, drawn: drawn(group.target) ? "unmarked" : "false", headers: [] });
  }
  // Lay out the full band first. Only when that cannot fit a fixed canvas do
  // repeated groups try the maintainer-approved all-inline compatibility path.
  function layoutBand(): { top: number; height: number; columns: number; rows: CalloutPlacement[] } {
    const top = contentBottom + 12, columns = frame.width >= 640 && bandGroups.reduce((n, group) => n + group.indices.length, 0) > 1 ? 2 : 1;
    const columnWidth = (frame.width - 32 - (columns - 1) * 24) / columns;
    const indexWidth = Math.max(24, typeWidthBudget(String(spec.callouts?.length ?? 0), "label"));
    const count = bandGroups.reduce((n, group) => n + group.indices.length, 0), firstColumn = Math.ceil(count / columns);
    const cursors = Array.from({ length: columns }, () => top + 12), rows: CalloutPlacement[] = [];
    let ordinal = 0;
    for (const group of bandGroups) {
      group.headers = [];
      for (const index of group.indices) {
        const column = columns === 1 || ordinal < firstColumn ? 0 : 1, x = 16 + column * (columnWidth + 24);
        if (!group.headers.some(header => header.x === x)) {
          const offset = group.key ? calloutKeyWidth(group.key) + 10 : 0;
          const header = wrapWords(`${group.name} · ${group.indices.length} ${group.indices.length === 1 ? "NOTE" : "NOTES"}`, columnWidth - offset, "label");
          const explanation = wrapCallout(group.explanation ?? (group.drawn === "false" ? undrawnCalloutExplanation(spec, group.target) : "Not marked: no clear spot on the drawing."), columnWidth);
          group.headers.push({ x, y: cursors[column]!, width: columnWidth, offset, lines: header.lines, explanation: group.drawn === "true" ? [] : explanation.lines });
          cursors[column]! += header.height + 8 + (group.drawn === "true" ? 0 : explanation.height + 4);
        }
        const note = spec.callouts![index]!, wrapped = wrapCallout(note.text, columnWidth - indexWidth - 8);
        rows.push({ index, target: group.target, name: group.name, text: note.text, placement: "band", box: { x: x + indexWidth + 8, y: cursors[column]!, width: wrapped.width, height: wrapped.height }, lines: wrapped.lines, indexX: x + indexWidth, column });
        cursors[column]! += 18 + Math.max(0, wrapped.lines.length - 1) * 14;
        ordinal++;
      }
      for (const header of group.headers) {
        const column = Math.round((header.x - 16) / (columnWidth + 24));
        cursors[column]! += 10;
      }
    }
    return { top, height: count ? Math.max(...cursors) - top + 4 : 0, columns, rows };
  }
  // Cue keys enumerate only safely marked targets. The target's own outline
  // is permitted contact; its text, every mask and unrelated geometry are not.
  function assignCues() {
    let key = 0;
    const cues: DiagramBox[] = [];
    for (const group of bandGroups) {
      group.drawn = drawn(group.target) ? "unmarked" : "false";
      group.key = undefined; group.cue = undefined;
      if (group.drawn === "false") continue;
      const width = calloutKeyWidth(key + 1), target = targetFor(group.target);
      const actual = target?.kind === "node" && ["initial", "final", "merge"].includes(target.shape ?? "") ? (() => {
        const radius = target.shape === "initial" ? 6 : target.shape === "final" ? 8 : 4;
        return { x: target.x + target.width / 2 - radius, y: target.y + target.height / 2 - radius, width: radius * 2, height: radius * 2 };
      })() : target;
      const attached = (point: DiagramPoint) => {
        if (!target) return true;
        if (target.kind === "shape" && target.shape === "circle") return Math.hypot(point.x - target.cx, point.y - target.cy) <= target.radius;
        const polygon = target.kind === "shape" && target.shape === "polygon" ? target.points : target.kind === "node" && target.shape === "decision" ? [{ x: target.x + target.width / 2, y: target.y }, { x: target.x + target.width, y: target.y + target.height / 2 }, { x: target.x + target.width / 2, y: target.y + target.height }, { x: target.x, y: target.y + target.height / 2 }] : undefined;
        if (!polygon) return true;
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const a = polygon[i]!, b = polygon[j]!;
          if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
      };
      const spots = actual ? [
        { x: actual.x + actual.width - 8, y: actual.y + 8 }, { x: actual.x + 8, y: actual.y + 8 },
        { x: actual.x + actual.width - 8, y: actual.y + actual.height - 8 }, { x: actual.x + 8, y: actual.y + actual.height - 8 },
      ] : routesFor(group.target).flatMap(route => [0.25, 0.75, 0.5].flatMap(fraction => { const point = pointAlongCalloutPath(route.points, fraction); return point ? [point] : []; }));
      group.cue = spots.filter(attached).map(point => ({ x: point.x - width / 2, y: point.y - 8, width, height: 16 })).find(box => within(pad(box, 4)) && !obstacles.some(obstacle => !(owns(obstacle.owner, group.target) && !obstacle.text) && overlaps(pad(box, 4), obstacle.box)) && !segments.some(segment => !owns(segment.owner, group.target) && overlaps(pad(box, 5), bounds(segment.a, segment.b))) && !placed.some(note => overlaps(pad(box, 4), note.box) || note.end && overlaps(pad(box, 4), pad(bounds(note.anchor!, note.end), 1))) && !cues.some(cue => overlaps(pad(box, 4), cue)));
      if (group.cue) { group.key = ++key; group.drawn = "true"; cues.push(group.cue); }
    }
  }
  assignCues();
  let band = layoutBand();
  const invalidGroupHeader = (group: CalloutGroup) => group.headers.some(header => header.lines.some(line => typeWidthBudget(line.toUpperCase(), "label") > header.width - header.offset) || header.explanation.some(line => typeWidthBudget(line, "note") > header.width));
  const rowFitsColumn = (note: CalloutPlacement) => {
    const group = bandGroups.find(group => group.target === note.target)!;
    const header = group.headers.find(header => note.indexX! >= header.x && note.indexX! < header.x + header.width)!;
    return note.box.x + note.box.width <= header.x + header.width;
  };
  const bandFits = () => !band.height || band.top + band.height + footerHeight + 16 <= frame.height && !bandGroups.some(invalidGroupHeader) && band.rows.every(rowFitsColumn);
  if (!grow && !bandFits()) {
    // Trial state is isolated: a partially fitting group must not consume
    // space or split its notes between the band and inline positions.
    for (let i = 0; i < bandGroups.length;) {
      const group = bandGroups[i]!;
      if (group.indices.length < 2) { i++; continue; }
      const start = placed.length, oldBottom = contentBottom;
      for (const index of group.indices) { const note = inline(index); if (!note) break; placed.push(note); contentBottom = Math.max(contentBottom, note.box.y + note.box.height); }
      if (placed.length - start === group.indices.length) {
        bandGroups.splice(i, 1); assignCues(); band = layoutBand();
        if (bandFits()) break;
      }
      else { placed.splice(start); contentBottom = oldBottom; i++; }
    }
    band = layoutBand();
  }
  // Inline compatibility placement can change which remaining cues clear.
  assignCues();
  band = layoutBand();
  const errors: CalloutPlan["errors"] = [];
  const fail = (index: number) => errors.push({ path: `$.callouts[${index}]`, code: "callout_room", message: "No collision-free readable callout or notes band fits; reserve space or choose size: fit" });
  for (const group of bandGroups) {
    const invalidHeader = invalidGroupHeader(group);
    for (const note of band.rows.filter(note => note.target === group.target)) if (invalidHeader || !rowFitsColumn(note) || !grow && !bandFits()) fail(note.index);
  }
  if (grow && placed.length + band.rows.length) frame.height = Math.ceil((Math.max(frame.height - footerHeight, contentBottom + 8, band.top + band.height) + footerHeight + 8) / 4) * 4;
  tree.viewBox = frame;
  return { placements: [...placed, ...band.rows].sort((a, b) => a.index - b.index), groups: bandGroups, bandTop: band.top, bandHeight: band.height, columns: band.columns, contentBottom, errors };
}
