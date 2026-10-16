import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { queryRoadblockReport, ROADBLOCK_REPORT_QUERY } from "../governance/roadblock-report.js";
import type { AppEnv } from "../app-env.js";
import { isGovernanceEventKind, queryGovernanceEvents, type GovernanceEventKind } from "../governance/events.js";

export const GOVERNANCE_EVENTS_DEFAULT_LIMIT = 100;
export const GOVERNANCE_EVENTS_MAX_LIMIT = 500;
const ID_MAX = 200;

/**
 * The governance-event read API (#1651). Auth-guarded like every /api route,
 * and open to every authenticated principal, as session history is. Read-only
 * and quiet: it renders nothing. Recorded tool inputs are credential-redacted
 * by the writer.
 */
export function createGovernanceRoutes(deps: { db: Database }): Hono<AppEnv> {
  const { db } = deps;
  return new Hono<AppEnv>().get("/governance/roadblocks", (c) => {
    const input: Record<string, number | string> = {};
    const remedies = c.req.queries("remedy");
    if (remedies !== undefined) {
      if (remedies.length !== 1) return c.json({ error: "remedy must be one filter" }, 400);
      input.remedy = remedies[0]!;
    }
    for (const name of ["hoursBack", "limit"]) {
      const values = c.req.queries(name);
      if (values === undefined) continue;
      if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return c.json({ error: `${name} must be one integer` }, 400);
      input[name] = Number(values[0]);
    }
    const query = ROADBLOCK_REPORT_QUERY.safeParse(input);
    if (!query.success) return c.json({ error: "hoursBack must be 1–2160, limit 1–100, and remedy actionable/all/guidance/capability/abandoned" }, 400);
    try {
      c.header("Cache-Control", "no-store");
      return c.json(queryRoadblockReport(db, query.data));
    } catch {
      return c.json({ error: "Failed to read roadblock report" }, 500);
    }
  }).get("/governance/events", (c) => {
    const one = (name: string): string | undefined | null => {
      const values = c.req.queries(name);
      if (!values) return undefined;
      return values.length === 1 && values[0]!.length > 0 && values[0]!.length <= ID_MAX ? values[0]! : null;
    };
    const sessionId = one("session");
    const turnId = one("turn");
    if (sessionId === null) return c.json({ error: "session must be one non-empty id" }, 400);
    if (turnId === null) return c.json({ error: "turn must be one non-empty id" }, 400);

    const kinds: GovernanceEventKind[] = [];
    for (const value of (c.req.queries("kind") ?? []).flatMap((v) => v.split(","))) {
      if (!isGovernanceEventKind(value)) return c.json({ error: `Unknown governance event kind: ${value}` }, 400);
      if (!kinds.includes(value)) kinds.push(value);
    }

    const integer = (name: string, min: number, max: number, fallback: number): number | null => {
      const raw = one(name);
      if (raw === undefined) return fallback;
      if (raw === null || !/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
    };
    const limit = integer("limit", 1, GOVERNANCE_EVENTS_MAX_LIMIT, GOVERNANCE_EVENTS_DEFAULT_LIMIT);
    if (limit === null) return c.json({ error: `limit must be an integer from 1 to ${GOVERNANCE_EVENTS_MAX_LIMIT}` }, 400);
    const after = integer("after", 0, Number.MAX_SAFE_INTEGER, 0);
    if (after === null) return c.json({ error: "after must be a non-negative integer event id" }, 400);

    try {
      const events = queryGovernanceEvents(db, {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
        kinds,
        after,
        limit,
      });
      // A full page may have more behind it; a short page is the end.
      const nextAfter = events.length === limit ? events.at(-1)!.id : null;
      c.header("Cache-Control", "no-store");
      return c.json({ events, nextAfter });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to read governance events" }, 500);
    }
  });
}
