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

// --- Palettes ----------------------------------------------------------------
//
// The canvas draws with VALUES, not CSS, so its palette arrives resolved: the
// kit's `--bk-canvas-*` tokens read for the scheme the page is in (see
// `use-graph-theme.ts`). Both sets are the kit's — the dark one ran through
// the dataviz validator against #0c0e12 (lightness band, chroma floor, CVD
// separation, 3:1), the paper one is the design's, each mark at 3:1 against
// #ece7dc. Slot ORDER is the CVD-safety mechanism and is the same in both
// themes: a theme may respell a slot, never reorder one.

export interface CanvasPalette {
  /** Eight categorical slots, in the frozen order. Community/folder identity. */
  slots: readonly string[];
  /** Ordinal distance ramp, near to far (five visible steps). */
  ramp: readonly string[];
  /** The root's own colour in discovery mode (the focus amber). */
  root: string;
  /** Recessive slot for everything past the eight distinguishable ones. */
  other: string;
  /** The maintenance lenses. */
  lens: { orphan: string; unreachable: string; broken: string; stale: string };
}

/** How many communities or folders get a slot of their own before the tail folds. */
export const SLOT_COUNT = 8;

/**
 * Linear blend of two hex colors: t=0 → a, t=1 → b. Used for the gentle
 * non-match fade during search highlight (half the strength of the hover
 * fade, which jumps straight to the edge color). Falls back to `b` when a
 * color is not parseable hex, so a bad token degrades to the strong fade
 * rather than an invalid color string.
 */
export function mixColors(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return b;
  const clamp = Math.max(0, Math.min(1, t));
  const channel = (i: number) => Math.round(pa[i]! + (pb[i]! - pa[i]!) * clamp);
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Color for a community. Communities are numbered by size (0 = largest) at
 * index time, so the first eight — the ones a legend can carry — get the
 * distinguishable slots and the long tail shares one recessive color.
 */
export function communityColor(community: number, palette: CanvasPalette): string {
  return community < palette.slots.length ? palette.slots[community]! : palette.other;
}

/** Color for a BFS distance: the root, then the ramp fading out hop by hop. */
export function distanceColor(distance: number, palette: CanvasPalette): string {
  if (distance <= 0) return palette.root;
  return palette.ramp[Math.min(distance - 1, palette.ramp.length - 1)]!;
}

/** First path segment — "career/opportunities/x.md" → "career". */
export function topLevelDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Assign categorical slots to top-level directories, biggest first — the
 * same eight-then-other policy as communities. Returns dir → color.
 */
export function assignFolderColors(paths: string[], palette: CanvasPalette): Map<string, string> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const dir = topLevelDir(path);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const colors = new Map<string, string>();
  ranked.forEach(([dir], i) => {
    colors.set(dir, i < palette.slots.length ? palette.slots[i]! : palette.other);
  });
  return colors;
}

// --- Community legend grouping ----------------------------------------------

export interface LegendGroups<T extends { community: number; size: number }> {
  /** Multi-note communities, size-descending — what the legend lists. */
  major: T[];
  /** Number of single-note communities folded out of the legend. */
  singletonCount: number;
}

/** Split a community list into legend-worthy entries and the singleton tail. */
export function groupCommunities<T extends { community: number; size: number }>(
  communities: T[]
): LegendGroups<T> {
  const major = communities
    .filter((c) => c.size > 1)
    .sort((a, b) => b.size - a.size || a.community - b.community);
  return { major, singletonCount: communities.length - major.length };
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

// --- Entity colouring ---------------------------------------------------------

/**
 * The kit's entity mapping (its `GraphView`, `PathRef` and inline mentions):
 * which document types wear which of the three entity colours. Every other
 * type — note, journal, study, whatever the taxonomy names — takes the
 * neutral ink and is listed in the legend under its own name, because a
 * legend that hides a type is a legend that lies about a node.
 */
export type EntityKind = "person" | "company" | "project";

export function entityKind(type: string): EntityKind | null {
  return type === "person" || type === "company" || type === "project" ? type : null;
}

/** The scene's document types, entity kinds first in the kit's order, then
 * the rest by count. Each carries how many nodes wear it. */
export function entityLegend(nodes: { type: string; virtual?: boolean }[]): { type: string; kind: EntityKind | null; count: number }[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.virtual) continue;
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  const order: string[] = ["person", "company", "project"];
  return [...counts.entries()]
    .map(([type, count]) => ({ type, kind: entityKind(type), count }))
    .sort((a, b) => {
      const ia = order.indexOf(a.type);
      const ib = order.indexOf(b.type);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
      return b.count - a.count || a.type.localeCompare(b.type);
    });
}
