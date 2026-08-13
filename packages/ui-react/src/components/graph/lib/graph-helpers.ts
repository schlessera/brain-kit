/**
 * Pure helpers for the graph view. No sigma, no DOM, no fetch — everything
 * here is deterministic and unit-tested. The canvas and store consume these;
 * keeping them pure is what makes the renderer swappable.
 */
import type {
  GraphNodePayload,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";

// --- Query strings -----------------------------------------------------------

/**
 * Build a query string from a param bag. null/undefined/empty-string values
 * are dropped; everything else is encoded. Returns "" when nothing survives.
 */
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

// --- Subgraph merging --------------------------------------------------------

/**
 * Merge an expansion fetch into the current scene. Nodes dedupe by id — the
 * richer record wins (more analytical fields), which in practice means an
 * existing node keeps its coordinates/metrics when the expansion returns a
 * barer copy. Edges dedupe by (source, target).
 */
export function mergeSubgraphs(
  base: GraphSubgraphResponse,
  addition: GraphSubgraphResponse
): GraphSubgraphResponse {
  const nodesById = new Map<number, GraphNodePayload>();
  for (const node of base.nodes) nodesById.set(node.id, node);
  for (const node of addition.nodes) {
    const existing = nodesById.get(node.id);
    nodesById.set(node.id, existing ? { ...node, ...existing } : node);
  }
  const edgeKeys = new Set<string>();
  const edges = [] as GraphSubgraphResponse["edges"];
  for (const edge of [...base.edges, ...addition.edges]) {
    const key = `${edge.source}->${edge.target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(edge);
  }
  return {
    nodes: [...nodesById.values()],
    edges,
    truncated: base.truncated || addition.truncated,
  };
}

// --- Radial (discovery) layout ----------------------------------------------

export interface RadialPoint {
  x: number;
  y: number;
}

/**
 * Deterministic radial layout for discovery mode: radius = BFS distance,
 * nodes ordered within their ring by id (stable across refetches), the root
 * (distance 0) at the origin. Rings get a slight angular offset per ring so
 * spokes don't visually align into artificial lines.
 */
export function radialLayout(
  nodes: Pick<GraphNodePayload, "id" | "distance">[],
  ringSpacing = 1
): Map<number, RadialPoint> {
  const rings = new Map<number, number[]>();
  for (const node of nodes) {
    const d = node.distance ?? 0;
    const ring = rings.get(d) ?? [];
    ring.push(node.id);
    rings.set(d, ring);
  }
  const positions = new Map<number, RadialPoint>();
  for (const [distance, ids] of rings) {
    ids.sort((a, b) => a - b);
    const radius = distance * ringSpacing;
    const offset = distance * 0.5; // radians; de-aligns consecutive rings
    ids.forEach((id, i) => {
      if (distance === 0) {
        positions.set(id, { x: 0, y: 0 });
        return;
      }
      const angle = offset + (2 * Math.PI * i) / ids.length;
      positions.set(id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    });
  }
  return positions;
}

// --- Node sizing -------------------------------------------------------------

export type SizeBy = "degree" | "pagerank";

/**
 * Node size in rendered pixels. Sqrt scale keeps hubs prominent without
 * letting a 45-in-degree hub dwarf the scene.
 */
export function nodeSize(
  node: Pick<GraphNodePayload, "inDegree" | "outDegree" | "pagerank" | "virtual">,
  sizeBy: SizeBy = "degree",
  min = 3,
  max = 14
): number {
  if (node.virtual) return max;
  let value: number;
  if (sizeBy === "pagerank" && node.pagerank !== undefined) {
    // Typical pagerank values are ~1/n; normalize into a usable range.
    value = node.pagerank * 1000;
  } else {
    value = node.inDegree + node.outDegree;
  }
  return Math.max(min, Math.min(max, min + Math.sqrt(value) * 1.8));
}

// --- Community palette -------------------------------------------------------

/**
 * Seed hues drawn from the app's entity colors (amber, teal, blue, purple),
 * continued by golden-angle rotation so any community count stays
 * distinguishable. Values are hex because WebGL renderers parse them cheaply.
 */
const SEED_HUES = [38, 168, 205, 270];
const GOLDEN_ANGLE = 137.508;

function hslToHex(h: number, s: number, l: number): string {
  const lightness = l / 100;
  const a = (s / 100) * Math.min(lightness, 1 - lightness);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lightness - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Color for community `i` (0-based). Deterministic; the first four match the
 * app's entity-color hues, later ones rotate by the golden angle. Saturation
 * and lightness are tuned for legibility on the dark background.
 */
export function communityColor(community: number): string {
  const hue =
    community < SEED_HUES.length
      ? SEED_HUES[community]!
      : (SEED_HUES[SEED_HUES.length - 1]! + GOLDEN_ANGLE * (community - SEED_HUES.length + 1)) % 360;
  return hslToHex(hue, 52, 62);
}

/** Sequential color for a BFS distance: bright near the root, fading out. */
export function distanceColor(distance: number, maxDistance: number): string {
  if (distance <= 0) return hslToHex(38, 70, 62); // the amber root
  const t = Math.min(1, distance / Math.max(1, maxDistance));
  // teal → desaturated slate as distance grows
  return hslToHex(168 + t * 40, 45 - t * 25, 60 - t * 22);
}

// --- Label policy ------------------------------------------------------------

export interface LabelPolicyInput {
  nodes: Pick<GraphNodePayload, "id" | "inDegree" | "outDegree" | "pagerank" | "virtual">[];
  selectedId: number | null;
  hoveredId: number | null;
  matchIds: ReadonlySet<number>;
  /** Camera ratio — sigma's zoom, 1 = fit, smaller = zoomed in. */
  cameraRatio: number;
}

/**
 * Which nodes must always carry a label: selection, hover, search matches,
 * the virtual root, plus the top-K nodes by rank where K grows as the user
 * zooms in. Never "all labels" — the renderer's own density threshold handles
 * the rest.
 */
export function labelSet(input: LabelPolicyInput): Set<number> {
  const forced = new Set<number>();
  if (input.selectedId !== null) forced.add(input.selectedId);
  if (input.hoveredId !== null) forced.add(input.hoveredId);
  for (const id of input.matchIds) forced.add(id);
  for (const node of input.nodes) if (node.virtual) forced.add(node.id);

  // Zoomed out (ratio >= 1): a handful of anchors. Each halving of the ratio
  // doubles the quota. Capped so a deep zoom cannot force thousands.
  const zoomFactor = Math.max(0.05, Math.min(4, input.cameraRatio));
  const quota = Math.min(60, Math.max(4, Math.round(8 / zoomFactor)));

  const ranked = [...input.nodes].sort((a, b) => rank(b) - rank(a));
  for (let i = 0; i < Math.min(quota, ranked.length); i++) {
    forced.add(ranked[i]!.id);
  }
  return forced;
}

function rank(
  node: Pick<GraphNodePayload, "inDegree" | "outDegree" | "pagerank">
): number {
  return node.pagerank !== undefined
    ? node.pagerank
    : (node.inDegree + node.outDegree) / 1e6;
}

// --- Scene search ------------------------------------------------------------

/** Ids of nodes whose title or path matches the in-scene query. */
export function matchScene(
  nodes: Pick<GraphNodePayload, "id" | "title" | "path">[],
  query: string
): Set<number> {
  const q = query.trim().toLowerCase();
  const matches = new Set<number>();
  if (q.length < 2) return matches;
  for (const node of nodes) {
    if (node.title.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
      matches.add(node.id);
    }
  }
  return matches;
}
