import { Hono } from "hono";
import {
  DEFAULT_STALE_DAYS,
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
 * `/graph/meta` always answers 200 — an unavailable graph is a described state,
 * not an error, and the client needs `reason` to pick its empty state. The
 * subgraph endpoints instead refuse with 503 rather than returning an empty
 * graph that would read as "your repo has no links".
 */
function errorResponse(err: unknown): {
  body: { error: string; reason?: string; param?: string };
  status: 400 | 404 | 503 | 500;
} {
  if (err instanceof GraphUnavailableError) {
    return { body: { error: "graph_unavailable", reason: err.reason }, status: 503 };
  }
  if (err instanceof GraphNotFoundError) {
    return { body: { error: "not_found" }, status: 404 };
  }
  console.error("[graph]", err);
  return { body: { error: err instanceof Error ? err.message : "internal_error" }, status: 500 };
}

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

export function createGraphRoutes(deps: { brainRoot: string }): Hono {
  const { brainRoot } = deps;
  return new Hono()
  .get("/graph/meta", (c) => c.json(getGraphMeta({ brainPath: brainRoot })))

  .get("/graph/clusters", (c) => {
    const rawCommunity = c.req.query("community");
    let community: number | undefined;
    if (rawCommunity !== undefined && rawCommunity !== "") {
      if (!/^\d+$/.test(rawCommunity)) return c.json(invalid("community"), 400);
      community = Number.parseInt(rawCommunity, 10);
    }

    try {
      return c.json(getClusters({ brainPath: brainRoot, community, includeIsolates: c.req.query("isolates") === "1" }));
    } catch (err) {
      const { body, status } = errorResponse(err);
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

    try {
      return c.json(getNeighborhood({ brainPath: brainRoot, center, depth, direction }));
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  })

  .get("/graph/discovery", (c) => {
    const root = c.req.query("root") || undefined;
    const direction = directionParam(c.req.query("direction"), ["out", "both"] as const, "out");
    if (direction === null) return c.json(invalid("direction"), 400);
    const maxDepth = intParam(c.req.query("maxDepth"), 1, MAX_DISCOVERY_DEPTH, MAX_DISCOVERY_DEPTH);
    if (maxDepth === null) return c.json(invalid("maxDepth"), 400);

    try {
      return c.json(getDiscovery({ brainPath: brainRoot, root, direction, maxDepth }));
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  })

  .get("/graph/maintenance", (c) => {
    const staleDays = intParam(c.req.query("staleDays"), 1, 3650, DEFAULT_STALE_DAYS);
    if (staleDays === null) return c.json(invalid("staleDays"), 400);

    try {
      return c.json(getMaintenance({ brainPath: brainRoot, staleDays }));
    } catch (err) {
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });
}
