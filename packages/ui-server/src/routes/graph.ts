import type { Logger } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import { createCoreQueryAccess, type CoreQueryAccess, type GraphQueries } from "../core-queries.js";
import {
  DEFAULT_STALE_DAYS,
  GraphBusyError,
  GraphIndexError,
  GraphNotFoundError,
  GraphUnavailableError,
  MAX_DISCOVERY_DEPTH,
  MAX_NEIGHBORHOOD_DEPTH,
  getClusters,
  getDiscovery,
  getGraphMeta,
  getMaintenance,
  getNeighborhood,
} from "../graph/reader.js";

/**
 * `/graph/meta` answers 200 for every described state of the INDEX — an
 * unavailable graph is a state, not an error, and the client needs `reason`
 * to pick its empty state. The subgraph endpoints instead refuse with 503
 * rather than returning an empty graph that would read as "your repo has no
 * links".
 *
 * Without a usable core query package there is no index state to describe,
 * so all five endpoints, meta included, refuse with 503
 * `graph_unavailable`/`core_unavailable`: the capability is missing, which is
 * neither a missing index nor a valid empty graph.
 */
function errorResponse(err: unknown, log?: Logger): {
  body: { error: string; reason?: string; param?: string };
  status: 400 | 404 | 503 | 500;
} {
  if (err instanceof GraphUnavailableError) {
    return { body: { error: "graph_unavailable", reason: err.reason }, status: 503 };
  }
  if (err instanceof GraphNotFoundError) {
    return { body: { error: "not_found" }, status: 404 };
  }
  if (err instanceof GraphBusyError) {
    return { body: { error: "index_busy" }, status: 503 };
  }
  // Core's failures carry only a code; anything else is logged by name, never
  // by message, so no native or SQL text reaches a response or a log line.
  const code = err instanceof GraphIndexError ? err.code : err instanceof Error ? err.name : "unknown";
  log?.emit({ severityText: "ERROR", body: "graph request failed", attributes: { "error.code": code } });
  return { body: { error: "internal_error" }, status: 500 };
}

const CORE_UNAVAILABLE = { error: "graph_unavailable", reason: "core_unavailable" } as const;

/** Returns null when the parameter is present but not an integer in range. */
function intParam(raw: string | undefined, min: number, max: number, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= min && value <= max ? value : null;
}

function directionParam<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T | null {
  if (raw === undefined || raw === "") return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function invalid(param: string) {
  return { error: "invalid_param", param } as const;
}

export function createGraphRoutes(deps: { brainRoot: string; log?: Logger; queries?: CoreQueryAccess }): Hono {
  const { brainRoot, log } = deps;
  const access = deps.queries ?? createCoreQueryAccess({ log });
  /** The validated graph operations, or null when core is not usable. */
  const graph = (): GraphQueries | null => {
    const capability = access.graph();
    return capability.ok ? capability.queries : null;
  };
  return new Hono()
  .get("/graph/meta", (c) => {
    const queries = graph();
    if (!queries) return c.json(CORE_UNAVAILABLE, 503);
    try {
      return c.json(getGraphMeta(queries, { brainPath: brainRoot }));
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  })

  .get("/graph/clusters", (c) => {
    const rawCommunity = c.req.query("community");
    let community: number | undefined;
    if (rawCommunity !== undefined && rawCommunity !== "") {
      if (!/^\d+$/.test(rawCommunity)) return c.json(invalid("community"), 400);
      community = Number.parseInt(rawCommunity, 10);
      // Core accepts only safe integers; a larger id names no community.
      if (!Number.isSafeInteger(community)) return c.json(invalid("community"), 400);
    }
    const queries = graph();
    if (!queries) return c.json(CORE_UNAVAILABLE, 503);

    try {
      return c.json(getClusters(queries, { brainPath: brainRoot, community, includeIsolates: c.req.query("isolates") === "1" }));
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  })

  .get("/graph/neighborhood", (c) => {
    const center = c.req.query("center");
    if (!center) return c.json({ error: "missing_center" }, 400);
    const depth = intParam(c.req.query("depth"), 1, MAX_NEIGHBORHOOD_DEPTH, 1);
    if (depth === null) return c.json(invalid("depth"), 400);
    const direction = directionParam(c.req.query("direction"), ["in", "out", "both"] as const, "both");
    if (direction === null) return c.json(invalid("direction"), 400);
    const queries = graph();
    if (!queries) return c.json(CORE_UNAVAILABLE, 503);

    try {
      return c.json(getNeighborhood(queries, { brainPath: brainRoot, center, depth, direction }));
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  })

  .get("/graph/discovery", (c) => {
    const root = c.req.query("root") || undefined;
    const direction = directionParam(c.req.query("direction"), ["out", "both"] as const, "out");
    if (direction === null) return c.json(invalid("direction"), 400);
    const maxDepth = intParam(c.req.query("maxDepth"), 1, MAX_DISCOVERY_DEPTH, MAX_DISCOVERY_DEPTH);
    if (maxDepth === null) return c.json(invalid("maxDepth"), 400);
    const queries = graph();
    if (!queries) return c.json(CORE_UNAVAILABLE, 503);

    try {
      return c.json(getDiscovery(queries, { brainPath: brainRoot, root, direction, maxDepth }));
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  })

  .get("/graph/maintenance", (c) => {
    const staleDays = intParam(c.req.query("staleDays"), 1, 3650, DEFAULT_STALE_DAYS);
    if (staleDays === null) return c.json(invalid("staleDays"), 400);
    const queries = graph();
    if (!queries) return c.json(CORE_UNAVAILABLE, 503);

    try {
      return c.json(getMaintenance(queries, { brainPath: brainRoot, staleDays }));
    } catch (err) {
      const { body, status } = errorResponse(err, log);
      return c.json(body, status);
    }
  });
}
