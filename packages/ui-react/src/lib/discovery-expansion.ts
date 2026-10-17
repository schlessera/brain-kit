import type { GraphNodePayload, GraphSubgraphResponse } from "@schlessera/brain-ui-sdk/protocol";

export const DISCOVERY_MAX_DEPTH = 8;
export interface DiscoveryIntent { id: number; path: string; distance: number; }
export interface DiscoveryEvidence { data: GraphSubgraphResponse; depth: number; }
export interface DiscoveryExpansionFailure { message: string; needsRefresh: boolean; }
export interface DiscoveryExpansionState {
  intents: readonly DiscoveryIntent[];
  loading: readonly string[];
  errors: Readonly<Record<string, DiscoveryExpansionFailure>>;
  unresolved: readonly string[];
  stale: boolean;
  /** Only an applied deliberate expansion produces motion or an addition notice. */
  transition: number | null;
  notice: { sequence: number; text: string } | null;
}
export interface DiscoveryExpansionAction {
  enabled: boolean;
  loading: boolean;
  count?: number;
  reason?: string;
  error?: string;
  needsRefresh?: boolean;
}
export const emptyDiscoveryExpansion = (): DiscoveryExpansionState => ({ intents: [], loading: [], errors: {}, unresolved: [], stale: false, transition: null, notice: null });

export function requiredDiscoveryDepth(baseDepth: number, intents: readonly DiscoveryIntent[]): number {
  return Math.min(DISCOVERY_MAX_DEPTH, Math.max(baseDepth, ...intents.map(n => n.distance + 1)));
}

/** A scene is a subset of exactly one response, including all node fields and edges. */
export function revealDiscovery(data: GraphSubgraphResponse, intents: readonly DiscoveryIntent[], baseDepth: number): GraphSubgraphResponse {
  const byPath = new Map(data.nodes.map(n => [n.path, n]));
  const expanded = new Set(intents.flatMap(n => {
    const resolved = byPath.get(n.path);
    return resolved ? [resolved.id] : [];
  }));
  const ids = new Set(data.nodes.filter(n => n.distance !== undefined && n.distance <= baseDepth).map(n => n.id));
  for (const edge of data.edges) if (expanded.has(edge.source)) ids.add(edge.target);
  const nodes = data.nodes.filter(n => ids.has(n.id)).sort((a, b) => a.id - b.id);
  const present = new Set(nodes.map(n => n.id));
  const edges = data.edges.filter(e => present.has(e.source) && present.has(e.target)).sort((a, b) => a.source - b.source || a.target - b.target);
  return { ...data, nodes, edges };
}

export function preservesDiscoveryBase(base: GraphSubgraphResponse, data: GraphSubgraphResponse): boolean {
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  return base.nodes.every(n => {
    const next = byId.get(n.id);
    return next?.path === n.path && next.distance === n.distance && Boolean(next.virtual) === Boolean(n.virtual);
  });
}

/** Missing shallow/capped/stale evidence retains intent; complete fresh depth-8 absence proves only the supported bound. */
export function revalidateDiscoveryIntents(intents: readonly DiscoveryIntent[], evidence: DiscoveryEvidence, stale: boolean): { intents: DiscoveryIntent[]; unresolved: string[] } {
  const byPath = new Map(evidence.data.nodes.map(n => [n.path, n]));
  const kept: DiscoveryIntent[] = [];
  const unresolved: string[] = [];
  for (const intent of intents) {
    const node = byPath.get(intent.path);
    if (node && node.distance !== undefined && node.distance <= DISCOVERY_MAX_DEPTH && !node.virtual) {
      kept.push({ id: node.id, path: node.path, distance: node.distance });
    } else if (evidence.depth < DISCOVERY_MAX_DEPTH || evidence.data.truncated || stale) {
      kept.push(intent);
      unresolved.push(intent.path);
    }
  }
  return { intents: kept.sort((a, b) => a.path.localeCompare(b.path)), unresolved: unresolved.sort() };
}

export function discoveryExpansionAction(node: GraphNodePayload, scene: GraphSubgraphResponse | null, evidence: DiscoveryEvidence | null, state: DiscoveryExpansionState, stale: boolean): DiscoveryExpansionAction {
  if (node.virtual || node.distance === undefined || node.distance > DISCOVERY_MAX_DEPTH) return { enabled: false, loading: false };
  if (state.loading.includes(node.path)) return { enabled: false, loading: true };
  const error = state.errors[node.path];
  if (error) return { enabled: !error.needsRefresh, loading: false, error: error.message, needsRefresh: error.needsRefresh };
  if (state.stale) return { enabled: false, loading: false, reason: "Refresh the graph to rebuild expanded notes." };
  if (!evidence || evidence.depth < Math.min(DISCOVERY_MAX_DEPTH, node.distance + 1)) {
    return node.distance < DISCOVERY_MAX_DEPTH ? { enabled: true, loading: false } : { enabled: false, loading: false, reason: "No more notes within 8 hops of the root" };
  }
  const resolved = evidence.data.nodes.find(n => n.path === node.path);
  if (!resolved) return { enabled: false, loading: false, reason: "No new notes in the current graph data (scene limited)" };
  const visible = new Set(scene?.nodes.map(n => n.id));
  const known = new Set(evidence.data.nodes.map(n => n.id));
  const candidates = new Set(evidence.data.edges.filter(e => e.source === resolved.id && known.has(e.target) && !visible.has(e.target)).map(e => e.target));
  if (candidates.size) return { enabled: true, loading: false, count: candidates.size };
  const reason = node.distance === DISCOVERY_MAX_DEPTH
    ? "No more notes within 8 hops of the root"
    : evidence.data.truncated || stale
      ? `No new notes in the current graph data (${stale ? "graph not recomputed since last sync" : "scene limited"})`
      : "All of this note's outgoing links are already shown";
  return { enabled: false, loading: false, count: 0, reason };
}
