import { expect } from "bun:test";
import type { DiagramSpec } from "../src/spec.js";
import type { DiagramBox, DiagramConnector, DiagramLabelMask, DiagramPoint, DiagramTree } from "../src/geometry.js";
const tolerance = 1e-6;
export function connectors(tree: DiagramTree) { return tree.elements.filter((item): item is DiagramConnector => item.kind === "connector"); }
export function masks(tree: DiagramTree) { return tree.elements.filter((item): item is DiagramLabelMask => item.kind === "label-mask"); }
function boxes(spec: DiagramSpec) { return spec.nodes.map(node => { if (!("at" in node)) throw Error("Free-layout fixture required"); return { id: node.id, x: node.at[0], y: node.at[1], width: node.size[0], height: node.size[1] }; }); }
const overlap = (a: DiagramBox, b: DiagramBox) => a.x < b.x + b.width - tolerance && a.x + a.width > b.x + tolerance && a.y < b.y + b.height - tolerance && a.y + a.height > b.y + tolerance;
function hit(a: DiagramPoint, b: DiagramPoint, box: DiagramBox) {
  return Math.abs(a.y - b.y) < tolerance ? a.y > box.y + tolerance && a.y < box.y + box.height - tolerance && Math.max(a.x, b.x) > box.x + tolerance && Math.min(a.x, b.x) < box.x + box.width - tolerance : a.x > box.x + tolerance && a.x < box.x + box.width - tolerance && Math.max(a.y, b.y) > box.y + tolerance && Math.min(a.y, b.y) < box.y + box.height - tolerance;
}
export function assertOrthogonal(spec: DiagramSpec, tree: DiagramTree) {
  for (const edge of connectors(tree)) {
    expect(edge.radius, "RULE_1_RADIUS").toBe(8);
    const arcs = [...edge.path.matchAll(/A ([\d.]+) ([\d.]+) 0 0 [01] ([\d.e+-]+) ([\d.e+-]+)/g)];
    expect(arcs.filter(arc => Number(arc[1]) !== 6 && Number(arc[1]) !== 8), "RULE_1_ARC_RADII").toEqual([]);
    expect(arcs.filter(arc => Number(arc[1]) === 8), "RULE_1_EVERY_CORNER_ROUNDED").toHaveLength(edge.points.length - 2);
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1]!, b = edge.points[i]!;
      expect(Math.abs(a.x - b.x) < tolerance || Math.abs(a.y - b.y) < tolerance, "RULE_1_ORTHOGONAL_SEGMENTS").toBe(true);
    }
    for (const [port, next] of [[edge.from, edge.points[1]!], [edge.to, edge.points.at(-2)!]] as const) {
      const box = boxes(spec).find(item => item.id === port.node); if (!box) continue;
      const horizontal = port.side === "left" || port.side === "right";
      expect(horizontal ? Math.abs(next.y - port.y) : Math.abs(next.x - port.x), "RULE_1_PERPENDICULAR_PORT").toBeLessThan(tolerance);
      const offset = horizontal ? port.y - box.y : port.x - box.x, extent = horizontal ? box.height : box.width;
      expect(offset, "RULE_1_PORT_CLEAR_OF_CORNER").toBeGreaterThanOrEqual(8 - tolerance);
      expect(extent - offset, "RULE_1_PORT_CLEAR_OF_OTHER_CORNER").toBeGreaterThanOrEqual(8 - tolerance);
    }
  }
}
export function assertLabelGap(_spec: DiagramSpec, tree: DiagramTree) {
  for (const mask of masks(tree)) {
    const edge = connectors(tree).find(edge => edge.edge === mask.edge)!, a = edge.points[mask.segment]!, b = edge.points[mask.segment + 1]!;
    const horizontal = Math.abs(a.y - b.y) < tolerance;
    const gap = horizontal ? mask.y >= a.y ? mask.y - a.y : a.y - mask.y - mask.height : mask.x >= a.x ? mask.x - a.x : a.x - mask.x - mask.width;
    expect(gap, "RULE_2_REAL_MASK_GAP_MIN").toBeGreaterThanOrEqual(6 - tolerance);
    expect(gap, "RULE_2_REAL_MASK_GAP_MAX").toBeLessThanOrEqual(10 + tolerance);
    expect(mask.opaque, "RULE_2_OPAQUE_MASK").toBe(true);
  }
}
export function assertIndependent(_spec: DiagramSpec, tree: DiagramTree) {
  const routes = connectors(tree);
  for (const route of routes) expect([...route.path.matchAll(/A 6 6 /g)], "RULE_3_HOPS_ARE_IN_PATH").toHaveLength(route.bridges.length);
  for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
    const first = routes[i]!, second = routes[j]!;
    for (let a = 1; a < first.points.length; a++) for (let b = 1; b < second.points.length; b++) {
      const p = first.points[a - 1]!, q = first.points[a]!, r = second.points[b - 1]!, s = second.points[b]!;
      const horizontal = Math.abs(p.y - q.y) < tolerance, otherHorizontal = Math.abs(r.y - s.y) < tolerance;
      if (horizontal === otherHorizontal) {
        const extent = horizontal ? Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)) : Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y));
        if (extent > tolerance) expect(horizontal ? Math.abs(p.y - r.y) : Math.abs(p.x - r.x), "RULE_3_PARALLEL_SEPARATION").toBeGreaterThanOrEqual(12 - tolerance);
      } else {
        const x = horizontal ? r.x : p.x, y = horizontal ? p.y : r.y;
        if (x <= Math.min(p.x, q.x) + tolerance || x >= Math.max(p.x, q.x) - tolerance || y < Math.min(p.y, q.y) - tolerance || y > Math.max(p.y, q.y) + tolerance || x < Math.min(r.x, s.x) - tolerance || x > Math.max(r.x, s.x) + tolerance || y < Math.min(r.y, s.y) - tolerance || y > Math.max(r.y, s.y) + tolerance) {
          // A vertical first segment has no x extent; use both bounding boxes below.
          if (!(x >= Math.min(p.x, q.x) - tolerance && x <= Math.max(p.x, q.x) + tolerance && y >= Math.min(p.y, q.y) - tolerance && y <= Math.max(p.y, q.y) + tolerance && x >= Math.min(r.x, s.x) - tolerance && x <= Math.max(r.x, s.x) + tolerance && y >= Math.min(r.y, s.y) - tolerance && y <= Math.max(r.y, s.y) + tolerance)) continue;
        }
        const hops = [...first.bridges.filter(hop => hop.over === second.id), ...second.bridges.filter(hop => hop.over === first.id)].filter(hop => Math.abs(hop.x - x) < tolerance && Math.abs(hop.y - y) < tolerance);
        expect(hops, "RULE_3_EXACTLY_ONE_BRIDGE_AT_CROSSING").toHaveLength(1);
      }
    }
  }
}
export function assertFan(spec: DiagramSpec, tree: DiagramTree) {
  const ports = new Map<string, { offset: number; length: number }[]>();
  for (const route of connectors(tree)) for (const port of [route.from, route.to]) {
    const box = boxes(spec).find(item => item.id === port.node); if (!box) continue;
    const vertical = port.side === "left" || port.side === "right", key = `${port.node}:${port.side}`, group = ports.get(key) ?? [];
    group.push({ offset: vertical ? port.y - box.y : port.x - box.x, length: vertical ? box.height : box.width }); ports.set(key, group);
  }
  for (const group of ports.values()) {
    group.sort((a, b) => a.offset - b.offset);
    group.forEach((port, i) => {
      expect(Math.abs(port.offset - port.length * (i + 1) / (group.length + 1)), "RULE_4_EVEN_FAN_FORMULA").toBeLessThan(tolerance);
      if (i) expect(port.offset - group[i - 1]!.offset, "RULE_4_MINIMUM_PORT_SEPARATION").toBeGreaterThanOrEqual((port.length < 48 ? 8 : 12) - tolerance);
    });
  }
}
export function assertTransit(spec: DiagramSpec, tree: DiagramTree) {
  for (const route of connectors(tree)) {
    const hidden = new Set<string>();
    for (const box of boxes(spec)) {
      if (box.id === route.from.node || box.id === route.to.node) continue;
      for (let i = 1; i < route.points.length; i++) if (hit(route.points[i - 1]!, route.points[i]!, box)) hidden.add(box.id);
    }
    expect([...hidden].sort(), "RULE_5_ALL_HIDDEN_TRANSIT_DECLARED").toEqual([...route.transit].sort());
    if (hidden.size) {
      expect(route.dashed, "RULE_5_UNAVOIDABLE_TRANSIT_DASHED").toBe(true);
      expect(route.points, "RULE_5_ONLY_DIRECT_UNAVOIDABLE_TRANSIT").toHaveLength(2);
      const mask = masks(tree).find(mask => mask.edge === route.edge);
      if (mask) {
        const first = route.points[0]!, last = route.points[1]!, horizontal = Math.abs(first.y - last.y) < tolerance;
        const leading = horizontal ? last.x > first.x ? mask.x : mask.x + mask.width : last.y > first.y ? mask.y : mask.y + mask.height;
        expect(Math.abs(leading - (horizontal ? first.x : first.y)), "RULE_5_LABEL_AT_VISIBLE_END").toBeLessThanOrEqual(8 + tolerance);
      }
    }
    expect(route.path.endsWith(`L ${route.to.x} ${route.to.y}`), "RULE_5_MARKER_AT_TRUE_DESTINATION").toBe(true);
  }
}
export function assertMasks(spec: DiagramSpec, tree: DiagramTree) {
  for (const mask of masks(tree)) {
    for (const box of boxes(spec)) expect(overlap(mask, box), "RULE_6_MASK_CLEAR_OF_NODES").toBe(false);
    const index = tree.elements.indexOf(mask);
    expect(tree.elements.slice(0, index).some(element => element.kind === "node"), "RULE_6_MASKS_BEFORE_NODES").toBe(false);
    expect(mask.x >= tree.viewBox.x && mask.y >= tree.viewBox.y && mask.x + mask.width <= tree.viewBox.width + tolerance && mask.y + mask.height <= tree.viewBox.height + tolerance, "RULE_6_MASK_INSIDE_CANVAS").toBe(true);
  }
}
export function assertSixRules(spec: DiagramSpec, tree: DiagramTree) { assertOrthogonal(spec, tree); assertLabelGap(spec, tree); assertIndependent(spec, tree); assertFan(spec, tree); assertTransit(spec, tree); assertMasks(spec, tree); assertPathCorrespondence(spec, tree); }

/** Parse actual emitted commands independently of the builder's serializer. */
export function assertPathCorrespondence(spec: DiagramSpec, tree: DiagramTree) {
  for (const route of connectors(tree)) {
    const token = /[MLA]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi;
    expect(route.path.replace(token, "").replace(/[\s,]/g, ""), "PATH_HAS_ONLY_SUPPORTED_COMMANDS").toBe("");
    const tokens = route.path.match(token)!, points = route.points;
    let position = 0, current: DiagramPoint | undefined, corner = 1, hops = 0;
    const number = () => { const value = Number(tokens[position++]); expect(Number.isFinite(value), "PATH_FINITE_NUMBER").toBe(true); return value; };
    const near = (a: DiagramPoint, b: DiagramPoint, label: string) => expect(Math.hypot(a.x - b.x, a.y - b.y), label).toBeLessThan(tolerance);
    const samples: DiagramPoint[] = [];
    while (position < tokens.length) {
      const command = tokens[position++];
      if (command === "M") { expect(current, "PATH_ONE_INITIAL_MOVE").toBeUndefined(); current = { x: number(), y: number() }; near(current, route.from, "PATH_STARTS_AT_ACTUAL_PORT"); }
      else if (command === "L") {
        const end = { x: number(), y: number() }; expect(current, "PATH_LINE_AFTER_MOVE").toBeDefined();
        expect(Math.abs(current!.x - end.x) < tolerance || Math.abs(current!.y - end.y) < tolerance, "PATH_ACTUAL_LINES_ARE_ORTHOGONAL").toBe(true);
        const liesOnSegment = points.slice(1).some((point, index) => {
          const a = points[index]!, b = point;
          const on = (p: DiagramPoint) => p.x >= Math.min(a.x, b.x) - tolerance && p.x <= Math.max(a.x, b.x) + tolerance && p.y >= Math.min(a.y, b.y) - tolerance && p.y <= Math.max(a.y, b.y) + tolerance && (Math.abs(a.x - b.x) < tolerance ? Math.abs(p.x - a.x) < tolerance : Math.abs(p.y - a.y) < tolerance);
          return on(current!) && on(end);
        });
        expect(liesOnSegment, "PATH_LINES_CORRESPOND_TO_ROUTED_SEGMENTS").toBe(true); samples.push(current!, end); current = end;
      } else if (command === "A") {
        const rx = number(), ry = number(), rotation = number(), large = number(), sweep = number(), end = { x: number(), y: number() };
        expect(rx, "PATH_CIRCULAR_ARC").toBe(ry); expect(rotation, "PATH_UNROTATED_ARC").toBe(0); expect(large, "PATH_MINOR_ARC").toBe(0);
        let center: DiagramPoint, angle: number;
        if (rx === 8) {
          const a = points[corner - 1]!, b = points[corner]!, c = points[corner + 1]!;
          expect(c, "PATH_HAS_A_CORRESPONDING_CORNER").toBeDefined();
          const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y), dx = (b.x - a.x) / before, dy = (b.y - a.y) / before, nx = (c.x - b.x) / after, ny = (c.y - b.y) / after;
          near(current!, { x: b.x - dx * 8, y: b.y - dy * 8 }, "PATH_CORNER_START_TRIMMED_BY_RADIUS");
          near(end, { x: b.x + nx * 8, y: b.y + ny * 8 }, "PATH_CORNER_END_TRIMMED_BY_RADIUS");
          expect(sweep, "PATH_CORRECT_QUARTER_ARC_SWEEP").toBe(dx * ny - dy * nx > 0 ? 1 : 0);
          center = { x: current!.x + nx * 8, y: current!.y + ny * 8 }; angle = sweep ? Math.PI / 2 : -Math.PI / 2; corner++;
        } else {
          expect(rx, "PATH_HOP_RADIUS").toBe(6); expect(sweep, "PATH_HOP_SWEEP").toBe(1);
          const hop = route.bridges.find(item => {
            const a = points[item.segment]!, b = points[item.segment + 1]!, size = Math.hypot(b.x - a.x, b.y - a.y);
            return Math.hypot(current!.x - (item.x - (b.x - a.x) / size * 6), current!.y - (item.y - (b.y - a.y) / size * 6)) < tolerance;
          });
          expect(hop, "PATH_HOP_AT_ACTUAL_CROSSING").toBeDefined(); center = { x: hop!.x, y: hop!.y };
          near(end, { x: 2 * center.x - current!.x, y: 2 * center.y - current!.y }, "PATH_HOP_IS_A_TRUE_SEMICIRCLE"); angle = Math.PI; hops++;
        }
        const startAngle = Math.atan2(current!.y - center.y, current!.x - center.x);
        for (let sample = 0; sample <= 16; sample++) samples.push({ x: center.x + rx * Math.cos(startAngle + angle * sample / 16), y: center.y + rx * Math.sin(startAngle + angle * sample / 16) });
        current = end;
      } else throw Error(`Unexpected actual path command ${command}`);
    }
    near(current!, route.to, "PATH_TERMINATES_AT_DESTINATION");
    expect(corner, "PATH_EMITS_EVERY_CORNER").toBe(points.length - 1); expect(hops, "PATH_EMITS_EVERY_HOP").toBe(route.bridges.length);
    for (const point of samples) {
      for (const box of boxes(spec)) if (!route.transit.includes(box.id)) expect(point.x > box.x + tolerance && point.x < box.x + box.width - tolerance && point.y > box.y + tolerance && point.y < box.y + box.height - tolerance, "PATH_ARC_CLEAR_OF_ACTUAL_NODES").toBe(false);
      for (const mask of masks(tree)) {
        const dx = Math.max(mask.x - point.x, 0, point.x - mask.x - mask.width), dy = Math.max(mask.y - point.y, 0, point.y - mask.y - mask.height);
        expect(Math.hypot(dx, dy), "PATH_CURVE_CLEAR_OF_LABEL_MASK").toBeGreaterThanOrEqual(6 - tolerance);
      }
    }
  }
}
