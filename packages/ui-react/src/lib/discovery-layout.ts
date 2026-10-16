import type {
  GraphNodePayload,
  GraphEdgePayload,
} from "@schlessera/brain-ui-sdk/protocol";

// Scene units only: presentation controls never feed the packing calculation.
export const DISCOVERY_PACKING = {
  pitch: 0.3,
  laneGap: 0.2,
  maxLanes: 4,
  gap: 0.05,
} as const;
type Node = Pick<GraphNodePayload, "id" | "distance" | "virtual"> & {
  community?: number | null;
};
export interface DiscoveryPoint {
  x: number;
  y: number;
  angle: number;
  radius: number;
  parent: number | null;
  branch: number | null;
  lane: number;
}
export interface DiscoveryWedge {
  id: number | null;
  start: number;
  end: number;
  demand: number;
}

/** Equal-weight isotonic regression, with deterministic adjacent pooling. */
function pav(values: number[]): number[] {
  const blocks: { sum: number; count: number }[] = [];
  for (const value of values) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!,
        a = blocks[blocks.length - 2]!;
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, count: a.count + b.count });
    }
  }
  return blocks.flatMap((b) => Array(b.count).fill(b.sum / b.count));
}

/**
 * Accepted #1482 rev 5: exact-hop bands, directed minimum-id predecessors,
 * scene-global lane/demand allocation and bounded PAV inside branch wedges.
 * Centres stay in wedges; proximity, edge crossings and changed-data locality
 * have no geometric guarantee. Missing predecessors and descendants stay visible.
 */
export function discoveryLayout(
  nodes: Node[],
  edges: Pick<GraphEdgePayload, "source" | "target">[]
) {
  const { pitch: P, laneGap: LG, maxLanes: Lmax, gap: GAP } = DISCOVERY_PACKING;
  const sorted = [...nodes].sort(
    (a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.id - b.id
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const counts = new Map<number, number>();
  for (const n of sorted) {
    const d = n.distance ?? 0;
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const lanes = new Map(
    [...counts].map(([d, n]) => [
      d,
      Math.min(Lmax, Math.max(1, Math.ceil((n * P) / (2 * Math.PI * d)))),
    ])
  );
  const parent = new Map<number, number>();
  for (const e of edges) {
    const u = byId.get(e.source),
      v = byId.get(e.target);
    if (!u || !v || (v.distance ?? 0) < 2 || u.distance !== v.distance! - 1)
      continue;
    if (!parent.has(v.id) || u.id < parent.get(v.id)!) parent.set(v.id, u.id);
  }
  const roots = sorted
    .filter((n) => n.distance === 1)
    .sort(
      (a, b) =>
        Number(a.community == null) - Number(b.community == null) ||
        (a.community ?? 0) - (b.community ?? 0) ||
        a.id - b.id
    );
  const rootId = sorted.find((n) => (n.distance ?? 0) === 0)?.id;
  const membership = new Map<number, number | null>();
  const groups = new Map<number | null, Map<number, Node[]>>();
  for (const n of sorted) {
    const d = n.distance ?? 0;
    if (d === 0) continue;
    if (d === 1 && rootId !== undefined) parent.set(n.id, rootId);
    const branch = d === 1 ? n.id : membership.get(parent.get(n.id)!) ?? null;
    membership.set(n.id, branch);
    if (!groups.has(branch)) groups.set(branch, new Map());
    const rings = groups.get(branch)!;
    const ring = rings.get(d) ?? [];
    ring.push(n);
    rings.set(d, ring);
  }
  const ids: (number | null)[] = roots.map((n) => n.id);
  if (groups.has(null)) ids.push(null);
  const demands = ids.map((id) =>
    Math.max(
      ...[...groups.get(id)!].map(
        ([d, ns]) => (ns.length * P) / (d * lanes.get(d)!)
      )
    )
  );
  const scale = demands.length
    ? (2 * Math.PI * (1 - GAP)) / demands.reduce((a, b) => a + b, 0)
    : 0;
  const gap = ids.length ? (2 * Math.PI * GAP) / ids.length : 0;
  let start = 0;
  const wedges: DiscoveryWedge[] = ids.map((id, i) => {
    const width = scale * demands[i]!;
    const wedge = { id, start, end: start + width, demand: demands[i]! };
    start += width + gap;
    return wedge;
  });
  const wedgeById = new Map(wedges.map((w) => [w.id, w]));
  const positions = new Map<number, DiscoveryPoint>();
  for (const n of sorted)
    if ((n.distance ?? 0) === 0)
      positions.set(n.id, {
        x: 0,
        y: 0,
        angle: 0,
        radius: 0,
        parent: null,
        branch: null,
        lane: 0,
      });
  // Complete each hop before the next: a predecessor's angle is already known.
  for (const d of [...counts.keys()].sort((a, b) => a - b))
    for (const id of ids) {
      const ns = groups.get(id)!.get(d);
      if (!ns) continue;
      const wedge = wedgeById.get(id)!;
      const target = (n: Node) =>
        positions.get(parent.get(n.id)!)?.angle ??
        (wedge.start + wedge.end) / 2;
      ns.sort(
        (a, b) =>
          target(a) - target(b) ||
          (parent.get(a.id) ?? -1) - (parent.get(b.id) ?? -1) ||
          a.id - b.id
      );
      const step = P / (d * lanes.get(d)!);
      const h = Math.min(step, (wedge.end - wedge.start) / ns.length);
      const z = pav(ns.map((n, i) => target(n) - i * h));
      const lo = wedge.start + h / 2,
        hi = wedge.end - h / 2 - (ns.length - 1) * h;
      ns.forEach((n, i) => {
        const angle =
          d === 1
            ? (wedge.start + wedge.end) / 2
            : Math.max(lo, Math.min(hi, z[i]!)) + i * h;
        const lane = i % lanes.get(d)!;
        const radius = d === 1 ? 1 : d + (lane - (lanes.get(d)! - 1) / 2) * LG;
        positions.set(n.id, {
          x: radius * Math.sin(angle),
          y: radius * Math.cos(angle),
          angle,
          radius,
          parent: parent.get(n.id) ?? null,
          branch: id,
          lane,
        });
      });
    }
  return { positions, wedges, lanes, counts, scale };
}

/** Only scene inputs that affect Discovery geometry, in canonical order. */
export function discoveryFingerprint(data: {
  nodes: Node[];
  edges: Pick<GraphEdgePayload, "source" | "target">[];
}): string {
  return JSON.stringify([
    [...data.nodes]
      .sort((a, b) => a.id - b.id)
      .map((n) => [
        n.id,
        n.distance ?? 0,
        n.community ?? null,
        n.virtual ?? false,
      ]),
    [...new Set(data.edges.map((e) => `${e.source}->${e.target}`))].sort(),
  ]);
}

/** Root identity includes virtual/physical transitions at the same path. */
export function discoveryRootIdentity(
  nodes: Pick<GraphNodePayload, "id" | "path" | "distance" | "virtual">[]
): string {
  return JSON.stringify(
    nodes
      .filter((n) => n.distance === 0)
      .sort((a, b) => a.id - b.id)
      .map((n) => [n.id, n.path, n.virtual ?? false])
  );
}
