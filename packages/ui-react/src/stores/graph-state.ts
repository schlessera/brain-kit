import { createStore } from "zustand/vanilla";
import type {
  GraphMetaResponse,
  GraphSubgraphResponse,
  GraphMaintenanceResponse,
  GraphNodePayload,
} from "@schlessera/brain-ui-sdk/protocol";
import type { StoreEnvironment } from "./store-environment.js";
import { discoveryFingerprint, discoveryRootIdentity } from "../lib/discovery-layout.js";
import { buildQuery, mergeSubgraphs } from "../lib/graph-helpers.js";
import {
  discoveryExpansionAction, emptyDiscoveryExpansion, preservesDiscoveryBase,
  requiredDiscoveryDepth, revealDiscovery, revalidateDiscoveryIntents,
  type DiscoveryEvidence, type DiscoveryExpansionAction, type DiscoveryExpansionState,
} from "../lib/discovery-expansion.js";

export type GraphMode = "clusters" | "discovery" | "local" | "maintenance";

export type LocalDirection = "in" | "out" | "both";

/**
 * How a fetch failed. "unavailable" carries the server's gating reason
 * (core unavailable / schema too old / not yet computed); "unsupported" means
 * the server predates the graph API entirely (404 on /graph/meta).
 */
export type GraphErrorKind = "unavailable" | "unsupported" | "network";

interface GraphError {
  kind: GraphErrorKind;
  reason?: "schema" | "not_computed" | "core_unavailable";
  message: string;
}
class DiscoveryIntegrityFailure extends Error {
  constructor(limited: boolean) {
    super("Could not apply expansion to the current graph; refresh and retry." + (limited ? " The fetched scene is limited." : ""));
  }
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
/**
 * The colouring rule for a scene drawn around a focus node — Discovery's
 * root or Local's centre (the field keeps its Discovery name; Local joined
 * it when the rule grew). The sixth pass §7: "entity-type joins the
 * colouring modes (topic · distance · folder · entity), because it is the
 * one mapping shared with `PathRef`, `GraphView` and inline mentions."
 * Clusters mode is the topic colouring itself and takes no rule.
 */
export type DiscoveryColorBy = "topic" | "distance" | "folder" | "entity";

/** Which finding sections are visible — a client-side filter, no refetch. */
export interface MaintenanceFilters {
  orphans: boolean;
  unreachable: boolean;
  broken: boolean;
  stale: boolean;
}

type FetchState = "idle" | "loading" | "done" | "error";

export interface GraphState {
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

  /** Once-per-changed-scene status identity, cleared by selection/scene changes. */
  layoutNotice: number | null;
  discoveryExpansion: DiscoveryExpansionState;
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
  /** Local merges a depth-1 ego; Discovery reveals bounded original-root outgoing targets. */
  expandNode: (path: string) => Promise<void>;
  discoveryExpansionFor: (node: GraphNodePayload) => DiscoveryExpansionAction;
  resetDiscoveryExpanded: () => Promise<void>;
  reset: () => void;
}

/** A missing server capability affects every mode, including Local. */
export function graphServerUnavailable(state: Pick<GraphState, "error" | "metaState">): boolean {
  return state.error?.reason === "core_unavailable" ||
    (state.metaState === "error" && state.error?.kind === "unsupported");
}

export function createGraphStore(env: StoreEnvironment) {
  const apiBase = env.apiBase;
  const fetch = env.request;

  /** Cache of scene responses, keyed by `${endpoint}?${query}|${computedAt}`. */
  const sceneCache = new Map<string, GraphSubgraphResponse | GraphMaintenanceResponse>();
  const SCENE_CACHE_MAX = 40;

  /** Test/dev hook: drop every cached scene. */
  function clearGraphSceneCache(): void {
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
  let noticeSequence = 0;
  let disposed = false;
  let sceneRequestToken = 0;
  let metaRequestToken = 0;
  let expansionGeneration = 0;
  let discoveryEpoch = 0;
  let discoveryBase: GraphSubgraphResponse | null = null;
  let evidence: DiscoveryEvidence | null = null;
  const discoveryRequests = new Map<string, Promise<GraphSubgraphResponse>>();
  const discoveryControllers = new Map<string, AbortController>();
  let expansionWorker: { generation: number; promise: Promise<void> } | null = null;

  function invalidateExpansion(clearIntent: boolean, fresh = false) {
    ++expansionGeneration;
    expansionWorker = null;
    for (const controller of discoveryControllers.values()) controller.abort();
    discoveryControllers.clear();
    discoveryRequests.clear();
    if (fresh) { ++discoveryEpoch; sceneCache.clear(); }
    discoveryBase = null;
    evidence = null;
    const prior = store.getState().discoveryExpansion;
    store.setState({ discoveryExpansion: clearIntent ? emptyDiscoveryExpansion() : {
      ...prior, loading: [], errors: {}, notice: null, transition: null, stale: store.getState().subgraph !== null,
    } });
  }

  async function discoveryAt(depth: number, state: GraphState): Promise<GraphSubgraphResponse> {
    const query = buildQuery({ root: state.discovery.root, maxDepth: depth });
    const key = `/discovery?${query}|${state.meta?.computedAt ?? ""}|${discoveryEpoch}`;
    const cached = sceneCache.get(key);
    if (cached) return cached as GraphSubgraphResponse;
    const shared = discoveryRequests.get(key);
    if (shared) return shared;
    const controller = new AbortController();
    const request = fetchGraphJson<GraphSubgraphResponse>(`/discovery?${query}`, controller.signal).then(data => {
      if (!disposed) cachePut(key, data);
      return data;
    });
    discoveryRequests.set(key, request);
    discoveryControllers.set(key, controller);
    try { return await request; }
    finally {
      if (discoveryRequests.get(key) === request) discoveryRequests.delete(key);
      if (discoveryControllers.get(key) === controller) discoveryControllers.delete(key);
    }
  }

  function expansionCurrent(generation: number, initial: GraphState): boolean {
    const current = store.getState();
    return !disposed && generation === expansionGeneration && current.mode === "discovery" &&
      current.meta?.computedAt === initial.meta?.computedAt && current.meta?.stale === initial.meta?.stale &&
      current.discovery.root === initial.discovery.root && current.discovery.maxDepth === initial.discovery.maxDepth;
  }

  async function rebuildDiscovery(token: number) {
    const initial = store.getState();
    invalidateExpansion(false);
    const generation = expansionGeneration;
    store.setState({ dataState: "loading", error: null, layoutNotice: null });
    try {
      const base = await discoveryAt(initial.discovery.maxDepth, initial);
      if (!expansionCurrent(generation, initial) || token !== sceneRequestToken) return;
      let intents = store.getState().discoveryExpansion.intents;
      const oldRoot = initial.subgraph?.nodes.find(n => n.virtual || n.distance === 0);
      const nextRoot = base.nodes.find(n => n.virtual || n.distance === 0);
      if (oldRoot && nextRoot && (oldRoot.path !== nextRoot.path || Boolean(oldRoot.virtual) !== Boolean(nextRoot.virtual))) intents = [];
      let depth = requiredDiscoveryDepth(initial.discovery.maxDepth, intents);
      let data = depth === initial.discovery.maxDepth ? base : await discoveryAt(depth, initial);
      if (!expansionCurrent(generation, initial) || token !== sceneRequestToken) return;
      let validated = revalidateDiscoveryIntents(intents, { data, depth }, initial.meta?.stale === true);
      const needed = requiredDiscoveryDepth(initial.discovery.maxDepth, validated.intents);
      // A moved/omitted path cannot be revalidated from its old shallow distance.
      // Depth eight is the existing bounded evidence path, never a cap bypass.
      if (intents.length && (validated.unresolved.length || needed > depth) && depth < 8) {
        depth = validated.unresolved.length ? 8 : needed;
        data = await discoveryAt(depth, initial);
        if (!expansionCurrent(generation, initial) || token !== sceneRequestToken) return;
        validated = revalidateDiscoveryIntents(intents, { data, depth }, initial.meta?.stale === true);
      }
      if (!preservesDiscoveryBase(base, data)) throw new DiscoveryIntegrityFailure(data.truncated);
      discoveryBase = base;
      evidence = { data, depth };
      const scene = revealDiscovery(data, validated.intents, initial.discovery.maxDepth);
      store.setState({ ...sceneResult(scene), error: null, discoveryExpansion: {
        ...emptyDiscoveryExpansion(), intents: validated.intents, unresolved: validated.unresolved,
      } });
    } catch (err) {
      if (!expansionCurrent(generation, initial) || token !== sceneRequestToken) return;
      sceneCache.clear();
      const error = toGraphError(err);
      store.setState({ ...(error.reason === "core_unavailable" ? { subgraph: null, findings: null } : {}),
        dataState: "error", error, layoutNotice: null,
        discoveryExpansion: { ...store.getState().discoveryExpansion, stale: true, loading: [], notice: null, transition: null } });
    }
  }

  function actionFor(node: GraphNodePayload): DiscoveryExpansionAction {
    const current = store.getState();
    if (current.mode !== "discovery") return { enabled: false, loading: false };
    if (current.metaState === "loading" || current.dataState === "loading") return { enabled: false, loading: false, reason: "Graph refresh in progress." };
    // A base injected by a consumer or already displayed by the page is valid
    // evidence only at its actual depth; no degree-based estimate is used.
    const known = evidence ?? (current.subgraph && !current.discoveryExpansion.intents.length
      ? { data: current.subgraph, depth: current.discovery.maxDepth } : null);
    return discoveryExpansionAction(node, current.subgraph, known, current.discoveryExpansion, current.meta?.stale === true);
  }

  async function expandDiscovery(path: string): Promise<void> {
    const initial = store.getState();
    const node = initial.subgraph?.nodes.find(n => n.path === path);
    if (!node || !actionFor(node).enabled || disposed || initial.metaState === "loading") return;
    const generation = expansionGeneration;
    if (!discoveryBase) discoveryBase = revealDiscovery(initial.subgraph!, [], initial.discovery.maxDepth);
    const errors = { ...initial.discoveryExpansion.errors }; delete errors[path];
    const intents = initial.discoveryExpansion.intents.filter(n => n.path !== path);
    intents.push({ id: node.id, path, distance: node.distance! });
    intents.sort((a, b) => a.path.localeCompare(b.path));
    store.setState({ discoveryExpansion: { ...initial.discoveryExpansion, intents,
      loading: [...new Set([...initial.discoveryExpansion.loading, path])].sort(), errors, notice: null, transition: null }, layoutNotice: null });
    if (expansionWorker?.generation === generation) return expansionWorker.promise;
    const worker = { generation, promise: Promise.resolve() };
    worker.promise = Promise.resolve().then(async () => {
      try {
        while (expansionCurrent(generation, initial)) {
          const requested = store.getState().discoveryExpansion.intents;
          const depth = requiredDiscoveryDepth(initial.discovery.maxDepth, requested);
          const data = await discoveryAt(depth, initial);
          if (!expansionCurrent(generation, initial)) return;
          const current = store.getState();
          if (requiredDiscoveryDepth(initial.discovery.maxDepth, current.discoveryExpansion.intents) > depth) continue;
          if (!discoveryBase || !preservesDiscoveryBase(discoveryBase, data)) {
            throw new DiscoveryIntegrityFailure(data.truncated);
          }
          const validated = revalidateDiscoveryIntents(current.discoveryExpansion.intents, { data, depth }, current.meta?.stale === true);
          const scene = revealDiscovery(data, validated.intents, initial.discovery.maxDepth);
          const before = new Set(current.subgraph?.nodes.map(n => n.id));
          const added = scene.nodes.filter(n => !n.virtual && !before.has(n.id)).length;
          const sequence = ++noticeSequence;
          evidence = { data, depth };
          store.setState({ ...sceneResult(scene), layoutNotice: null, error: null,
            discoveryExpansion: { ...emptyDiscoveryExpansion(), intents: validated.intents, unresolved: validated.unresolved,
              transition: sequence, notice: { sequence, text: added ? `${added} note${added === 1 ? "" : "s"} added · Layout updated` : "No new notes added" } } });
          return;
        }
      } catch (err) {
        if (!expansionCurrent(generation, initial)) return;
        sceneCache.clear();
        const current = store.getState().discoveryExpansion;
        const errors = { ...current.errors };
        const needsRefresh = err instanceof DiscoveryIntegrityFailure;
        const message = needsRefresh ? err.message : "Couldn't load more links.";
        for (const path of current.loading) errors[path] = { message, needsRefresh };
        store.setState({ discoveryExpansion: { ...current, loading: [], errors, notice: null, transition: null }, layoutNotice: null });
      } finally { if (expansionWorker === worker) expansionWorker = null; }
    });
    expansionWorker = worker;
    return worker.promise;
  }

  function cachePut(key: string, value: GraphSubgraphResponse | GraphMaintenanceResponse) {
    if (sceneCache.size >= SCENE_CACHE_MAX) {
      const oldest = sceneCache.keys().next().value;
      if (oldest !== undefined) sceneCache.delete(oldest);
    }
    sceneCache.set(key, value);
  }

  async function fetchGraphJson<T>(pathAndQuery: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${apiBase()}/graph${pathAndQuery}`, signal ? { signal } : undefined);
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
        reason: e.reason === "core_unavailable" ? "core_unavailable" : e.reason === "schema" ? "schema" : "not_computed",
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

  function sceneResult(data: GraphSubgraphResponse): Partial<GraphState> {
    const current = store.getState();
    const selectedPath = current.subgraph?.nodes.find(n => n.id === current.selectedId)?.path;
    const rootChanged = current.mode === "discovery" && current.subgraph !== null &&
      discoveryRootIdentity(current.subgraph.nodes) !== discoveryRootIdentity(data.nodes);
    const selectedId = current.mode === "discovery"
      ? !rootChanged && data.nodes.some(n => n.id === current.selectedId && (selectedPath === undefined || n.path === selectedPath)) ? current.selectedId : null
      : current.selectedId;
    const changed = current.mode === "discovery" && current.subgraph !== null &&
      discoveryFingerprint(current.subgraph) !== discoveryFingerprint(data);
    return { subgraph: data, findings: null, dataState: "done", selectedId,
      layoutNotice: changed && selectedId !== null ? ++noticeSequence : null };
  }

  const store = createStore<GraphState>((set, get) => ({
    /**
     * Clusters, not Local.
     *
     * Local is centred on ONE node and has no center until the user picks one,
     * so opening the graph landed on an empty canvas with a picker — which reads
     * as "the graph is broken", not as "choose a starting point". Clusters is
     * the only mode that answers the question someone opening a graph view is
     * actually asking: what is in here, and what clumps together.
     *
     * Local stays one click away, and clicking any node still switches to it
     * (node-popover.tsx) — that is the natural way in, rather than the landing
     * state.
     */
    mode: "clusters",
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
    layoutNotice: null,
    discoveryExpansion: emptyDiscoveryExpansion(),
    selectedId: null,
    hoveredId: null,

    setMode: (mode) => {
      if (mode === get().mode) return;
      invalidateExpansion(true);
      const error = graphServerUnavailable(get()) ? get().error : null;
      set({ mode, subgraph: null, findings: null, dataState: "idle", error, layoutNotice: null, selectedId: null, hoveredId: null, sceneQuery: "" });
      void get().fetchScene();
    },
    setLocalParams: (params) => {
      set((s) => ({ local: { ...s.local, ...params }, selectedId: null, layoutNotice: null }));
      if (get().mode === "local") void get().fetchScene();
    },
    setDiscoveryParams: (params) => {
      invalidateExpansion(true);
      set((s) => ({ discovery: { ...s.discovery, ...params }, subgraph: s.mode === "discovery" ? null : s.subgraph, selectedId: null, layoutNotice: null }));
      if (get().mode === "discovery") void get().fetchScene();
    },
    setClustersParams: (params) => {
      set((s) => ({ clusters: { ...s.clusters, ...params }, selectedId: null, layoutNotice: null }));
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
    setSceneQuery: (q) => {
      if (get().mode === "discovery" && q !== get().sceneQuery) {
        const base = discoveryBase;
        const stale = get().discoveryExpansion.stale;
        invalidateExpansion(true);
        if (base && !stale) { discoveryBase = base; evidence = { data: base, depth: get().discovery.maxDepth }; set(sceneResult(base)); }
        else void get().fetchScene();
      }
      set({ sceneQuery: q });
    },
    select: (id) => set(s => ({ selectedId: id, layoutNotice: s.selectedId === id ? s.layoutNotice : null })),
    hover: (id) => set({ hoveredId: id }),

    fetchMeta: async (force) => {
      if (disposed) return;
      const { metaState } = get();
      if (!force && (metaState === "loading" || metaState === "done")) return;
      const token = ++metaRequestToken;
      if (get().mode === "discovery") { ++sceneRequestToken; invalidateExpansion(false, true); }
      set({ metaState: "loading" });
      try {
        const meta = await fetchGraphJson<GraphMetaResponse>("/meta");
        if (token !== metaRequestToken) return;
        const error = graphServerUnavailable(get()) ? null : get().error;
        const previousRoot = get().meta?.defaultRoot;
        if (get().mode === "discovery" && get().discovery.root === null &&
            (previousRoot?.path !== meta.defaultRoot?.path || previousRoot?.virtual !== meta.defaultRoot?.virtual)) invalidateExpansion(true);
        set({ meta, metaState: "done", error });
      } catch (err) {
        if (token !== metaRequestToken) return;
        const error = toGraphError(err);
        if (error.reason === "core_unavailable" || error.kind === "unsupported") {
          ++sceneRequestToken;
          sceneCache.clear();
          set({ meta: null, subgraph: null, findings: null, dataState: "idle", layoutNotice: null });
        }
        set({ metaState: "error", error });
      }
    },

    fetchScene: async () => {
      if (disposed) return;
      const state = get();
      if (graphServerUnavailable(state)) return;
      const token = ++sceneRequestToken;
      if (state.mode === "discovery") { await rebuildDiscovery(token); return; }
      const req = sceneRequest(state);
      if (!req) {
        // Local mode without a center: nothing to fetch, the page shows the picker.
        set({ subgraph: null, findings: null, dataState: "idle", error: null, layoutNotice: null });
        return;
      }
      const cacheKey = `${req.endpoint}?${req.query}|${state.meta?.computedAt ?? ""}`;
      const cached = sceneCache.get(cacheKey);
      if (cached) {
        if (state.mode === "maintenance") {
          set({ findings: cached as GraphMaintenanceResponse, subgraph: null, dataState: "done", error: null });
        } else {
          set({ ...sceneResult(cached as GraphSubgraphResponse), error: null });
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
        if (disposed) return;
        cachePut(cacheKey, data);
        if (token !== sceneRequestToken) return;
        if (requestedMode === "maintenance") {
          set({ findings: data as GraphMaintenanceResponse, subgraph: null, dataState: "done" });
        } else {
          set(sceneResult(data as GraphSubgraphResponse));
        }
      } catch (err) {
        if (token !== sceneRequestToken) return;
        const error = toGraphError(err);
        if (error.reason === "core_unavailable") {
          sceneCache.clear();
          set({ subgraph: null, findings: null });
        }
        set({ dataState: "error", error, layoutNotice: null });
      }
    },

    expandNode: async (path) => {
      const state = get();
      if (!disposed && state.mode === "discovery") { await expandDiscovery(path); return; }
      if (disposed || state.mode !== "local" || !state.subgraph) return;
      try {
        const ego = await fetchGraphJson<GraphSubgraphResponse>(
          `/neighborhood?${buildQuery({ center: path, depth: 1, direction: "both" })}`
        );
        const current = get();
        if (disposed || current.mode !== "local" || !current.subgraph) return;
        set({ subgraph: mergeSubgraphs(current.subgraph, ego) });
      } catch (err) {
        const current = get();
        if (disposed || current.mode !== "local" || current.subgraph !== state.subgraph) return;
        const error = toGraphError(err);
        if (error.reason === "core_unavailable") {
          ++sceneRequestToken;
          sceneCache.clear();
          set({ subgraph: null, findings: null, dataState: "error", error });
        }
        // Other expansion failures leave the scene as-is.
      }
    },

    discoveryExpansionFor: actionFor,
    resetDiscoveryExpanded: async () => {
      if (disposed || get().mode !== "discovery") return;
      const base = discoveryBase;
      const stale = get().discoveryExpansion.stale;
      ++sceneRequestToken;
      invalidateExpansion(true);
      if (base && !stale) {
        discoveryBase = base;
        evidence = { data: base, depth: get().discovery.maxDepth };
        set(sceneResult(base));
      } else { await get().fetchScene(); }
    },
    reset: () => {
      ++sceneRequestToken;
      ++metaRequestToken;
      invalidateExpansion(true);
      set({
        subgraph: null,
        findings: null,
        dataState: "idle",
        error: null,
        layoutNotice: null,
        selectedId: null,
        hoveredId: null,
        sceneQuery: "",
      });
    },
  }));

  return Object.assign(store, { clearSceneCache: clearGraphSceneCache, dispose() {
    disposed = true; sceneRequestToken++; metaRequestToken++; expansionGeneration++; expansionWorker = null;
    for (const controller of discoveryControllers.values()) controller.abort();
    discoveryControllers.clear(); discoveryRequests.clear(); sceneCache.clear();
  } });
}
