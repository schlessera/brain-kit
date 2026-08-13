import { create } from "zustand";
import type {
  GraphMetaResponse,
  GraphSubgraphResponse,
  GraphMaintenanceResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import { API_BASE } from "../lib/backend.js";
import { buildQuery, mergeSubgraphs } from "../components/graph/lib/graph-helpers.js";

export type GraphMode = "clusters" | "discovery" | "local" | "maintenance";

export type LocalDirection = "in" | "out" | "both";

/**
 * How a fetch failed. "unavailable" carries the server's gating reason
 * (schema too old / not yet computed); "unsupported" means the server predates
 * the graph API entirely (404 on /graph/meta).
 */
export type GraphErrorKind = "unavailable" | "unsupported" | "network";

interface GraphError {
  kind: GraphErrorKind;
  reason?: "schema" | "not_computed";
  message: string;
}

export interface LocalParams {
  center: string | null;
  depth: 1 | 2 | 3;
  direction: LocalDirection;
}

export interface DiscoveryParams {
  /** null = the precomputed default root (direction is fixed there). */
  root: string | null;
  maxDepth: number;
}

export interface ClustersParams {
  /** null = all communities. */
  community: number | null;
  isolates: boolean;
}

export interface MaintenanceParams {
  staleDays: number;
}

export type SizeBy = "degree" | "pagerank";
export type DiscoveryColorBy = "distance" | "folder";

/** Which finding sections are visible — a client-side filter, no refetch. */
export interface MaintenanceFilters {
  orphans: boolean;
  unreachable: boolean;
  broken: boolean;
  stale: boolean;
}

type FetchState = "idle" | "loading" | "done" | "error";

interface GraphState {
  mode: GraphMode;
  meta: GraphMetaResponse | null;
  metaState: FetchState;

  local: LocalParams;
  discovery: DiscoveryParams;
  clusters: ClustersParams;
  maintenance: MaintenanceParams;

  /** Scene for the current mode (subgraph modes). */
  subgraph: GraphSubgraphResponse | null;
  findings: GraphMaintenanceResponse | null;
  dataState: FetchState;
  error: GraphError | null;

  /** In-scene search query — highlights matching nodes, does not refetch. */
  sceneQuery: string;

  // Display-only knobs: they restyle the current scene, never refetch.
  clustersSizeBy: SizeBy;
  discoveryColorBy: DiscoveryColorBy;
  maintenanceFilters: MaintenanceFilters;

  selectedId: number | null;
  hoveredId: number | null;

  setMode: (mode: GraphMode) => void;
  setLocalParams: (params: Partial<LocalParams>) => void;
  setDiscoveryParams: (params: Partial<DiscoveryParams>) => void;
  setClustersParams: (params: Partial<ClustersParams>) => void;
  setMaintenanceParams: (params: Partial<MaintenanceParams>) => void;
  setClustersSizeBy: (sizeBy: SizeBy) => void;
  setDiscoveryColorBy: (colorBy: DiscoveryColorBy) => void;
  setMaintenanceFilters: (filters: Partial<MaintenanceFilters>) => void;
  setSceneQuery: (q: string) => void;
  select: (id: number | null) => void;
  hover: (id: number | null) => void;

  fetchMeta: (force?: boolean) => Promise<void>;
  /** Fetch the scene for the current mode + params (cached per query + computedAt). */
  fetchScene: () => Promise<void>;
  /** Local mode: pull the depth-1 ego of a node and merge it into the scene. */
  expandNode: (path: string) => Promise<void>;
  reset: () => void;
}

/** Cache of scene responses, keyed by `${endpoint}?${query}|${computedAt}`. */
const sceneCache = new Map<string, GraphSubgraphResponse | GraphMaintenanceResponse>();
const SCENE_CACHE_MAX = 40;

/** Test/dev hook: drop every cached scene. */
export function clearGraphSceneCache(): void {
  sceneCache.clear();
}

/**
 * Monotonic tokens for scene and meta fetches. Every call claims a new
 * token; only the holder of the latest token may write results (success OR
 * error), so a slow older response can never overwrite newer state. Meta
 * needs this too: forced mount-time refetches can overlap when the view is
 * toggled quickly, and an older /meta response landing last would restore a
 * stale computedAt — which is the key every scene-cache lookup hangs off.
 */
let sceneRequestToken = 0;
let metaRequestToken = 0;

function cachePut(key: string, value: GraphSubgraphResponse | GraphMaintenanceResponse) {
  if (sceneCache.size >= SCENE_CACHE_MAX) {
    const oldest = sceneCache.keys().next().value;
    if (oldest !== undefined) sceneCache.delete(oldest);
  }
  sceneCache.set(key, value);
}

async function fetchGraphJson<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${API_BASE}/graph${pathAndQuery}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const err = new Error(
      (body as { error?: string }).error || `HTTP ${res.status}`
    ) as Error & { status: number; reason?: string };
    err.status = res.status;
    err.reason = (body as { reason?: string }).reason;
    throw err;
  }
  return res.json() as Promise<T>;
}

function toGraphError(err: unknown): GraphError {
  const e = err as Error & { status?: number; reason?: string };
  if (e.status === 404) {
    return {
      kind: "unsupported",
      message: "This server does not know the graph API yet.",
    };
  }
  if (e.status === 503) {
    return {
      kind: "unavailable",
      reason: e.reason === "schema" ? "schema" : "not_computed",
      message: e.message || "graph_unavailable",
    };
  }
  return { kind: "network", message: e.message || "Request failed" };
}

function sceneRequest(state: GraphState): { endpoint: string; query: string } | null {
  switch (state.mode) {
    case "clusters":
      return {
        endpoint: "/clusters",
        query: buildQuery({
          community: state.clusters.community,
          isolates: state.clusters.isolates ? 1 : null,
        }),
      };
    case "discovery":
      return {
        endpoint: "/discovery",
        query: buildQuery({
          root: state.discovery.root,
          maxDepth: state.discovery.maxDepth,
        }),
      };
    case "local":
      if (!state.local.center) return null;
      return {
        endpoint: "/neighborhood",
        query: buildQuery({
          center: state.local.center,
          depth: state.local.depth,
          direction: state.local.direction,
        }),
      };
    case "maintenance":
      return {
        endpoint: "/maintenance",
        query: buildQuery({ staleDays: state.maintenance.staleDays }),
      };
  }
}

export const useGraphStore = create<GraphState>((set, get) => ({
  mode: "local",
  meta: null,
  metaState: "idle",

  local: { center: null, depth: 1, direction: "both" },
  discovery: { root: null, maxDepth: 8 },
  clusters: { community: null, isolates: false },
  maintenance: { staleDays: 180 },

  subgraph: null,
  findings: null,
  dataState: "idle",
  error: null,

  sceneQuery: "",
  clustersSizeBy: "degree",
  discoveryColorBy: "distance",
  maintenanceFilters: { orphans: true, unreachable: true, broken: true, stale: true },
  selectedId: null,
  hoveredId: null,

  setMode: (mode) => {
    if (mode === get().mode) return;
    set({ mode, subgraph: null, findings: null, dataState: "idle", error: null, selectedId: null, hoveredId: null, sceneQuery: "" });
    void get().fetchScene();
  },
  setLocalParams: (params) => {
    set((s) => ({ local: { ...s.local, ...params }, selectedId: null }));
    if (get().mode === "local") void get().fetchScene();
  },
  setDiscoveryParams: (params) => {
    set((s) => ({ discovery: { ...s.discovery, ...params }, selectedId: null }));
    if (get().mode === "discovery") void get().fetchScene();
  },
  setClustersParams: (params) => {
    set((s) => ({ clusters: { ...s.clusters, ...params }, selectedId: null }));
    if (get().mode === "clusters") void get().fetchScene();
  },
  setMaintenanceParams: (params) => {
    set((s) => ({ maintenance: { ...s.maintenance, ...params } }));
    if (get().mode === "maintenance") void get().fetchScene();
  },
  setClustersSizeBy: (sizeBy) => set({ clustersSizeBy: sizeBy }),
  setDiscoveryColorBy: (colorBy) => set({ discoveryColorBy: colorBy }),
  setMaintenanceFilters: (filters) =>
    set((s) => ({ maintenanceFilters: { ...s.maintenanceFilters, ...filters } })),
  setSceneQuery: (q) => set({ sceneQuery: q }),
  select: (id) => set({ selectedId: id }),
  hover: (id) => set({ hoveredId: id }),

  fetchMeta: async (force) => {
    const { metaState } = get();
    if (!force && (metaState === "loading" || metaState === "done")) return;
    const token = ++metaRequestToken;
    set({ metaState: "loading" });
    try {
      const meta = await fetchGraphJson<GraphMetaResponse>("/meta");
      if (token !== metaRequestToken) return;
      set({ meta, metaState: "done" });
    } catch (err) {
      if (token !== metaRequestToken) return;
      set({ metaState: "error", error: toGraphError(err) });
    }
  },

  fetchScene: async () => {
    const state = get();
    const token = ++sceneRequestToken;
    const req = sceneRequest(state);
    if (!req) {
      // Local mode without a center: nothing to fetch, the page shows the picker.
      set({ subgraph: null, findings: null, dataState: "idle", error: null });
      return;
    }
    const cacheKey = `${req.endpoint}?${req.query}|${state.meta?.computedAt ?? ""}`;
    const cached = sceneCache.get(cacheKey);
    if (cached) {
      if (state.mode === "maintenance") {
        set({ findings: cached as GraphMaintenanceResponse, subgraph: null, dataState: "done", error: null });
      } else {
        set({ subgraph: cached as GraphSubgraphResponse, findings: null, dataState: "done", error: null });
      }
      return;
    }
    set({ dataState: "loading", error: null });
    const requestedMode = state.mode;
    try {
      const data = await fetchGraphJson<GraphSubgraphResponse | GraphMaintenanceResponse>(
        `${req.endpoint}${req.query ? `?${req.query}` : ""}`
      );
      // The cache is always safe to fill; the visible scene belongs to the
      // latest request only (rapid param changes race their responses).
      cachePut(cacheKey, data);
      if (token !== sceneRequestToken) return;
      if (requestedMode === "maintenance") {
        set({ findings: data as GraphMaintenanceResponse, subgraph: null, dataState: "done" });
      } else {
        set({ subgraph: data as GraphSubgraphResponse, findings: null, dataState: "done" });
      }
    } catch (err) {
      if (token !== sceneRequestToken) return;
      set({ dataState: "error", error: toGraphError(err) });
    }
  },

  expandNode: async (path) => {
    const state = get();
    if (state.mode !== "local" || !state.subgraph) return;
    try {
      const ego = await fetchGraphJson<GraphSubgraphResponse>(
        `/neighborhood?${buildQuery({ center: path, depth: 1, direction: "both" })}`
      );
      const current = get();
      if (current.mode !== "local" || !current.subgraph) return;
      set({ subgraph: mergeSubgraphs(current.subgraph, ego) });
    } catch {
      // Expansion is additive sugar — a failure leaves the scene as-is.
    }
  },

  reset: () =>
    set({
      subgraph: null,
      findings: null,
      dataState: "idle",
      error: null,
      selectedId: null,
      hoveredId: null,
      sceneQuery: "",
    }),
}));

// Dev-only handle for exercising the view with injected fixtures (the
// window.__chatStore precedent). The env read is defensive: outside a Vite
// build `import.meta.env` does not exist.
const devEnv = (import.meta as { env?: Record<string, unknown> }).env;
if (typeof window !== "undefined" && devEnv?.DEV) {
  (window as unknown as { __graphStore?: typeof useGraphStore }).__graphStore =
    useGraphStore;
}
