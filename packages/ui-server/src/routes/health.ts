import { Hono } from "hono";

const startTime = Date.now();

// Public liveness probe. Deliberately minimal: no version/commit, no cron
// detail, no session oracle — this route sits in front of the auth guard and
// is reachable by anyone on the origin.
export const healthRoutes = new Hono().get("/health", (c) => {
  return c.json({
    status: "healthy",
    uptime: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
});

export interface StatusDeps {
  /** Git SHA baked at build time (SOURCE_COMMIT), "dev" when unset. */
  sourceCommit: string;
  getCronStatus(): unknown;
  isTurnActive(): boolean;
}

// Operational status. Registered BEHIND the auth guard: it exposes the git SHA,
// cron job errors (raw stderr with filesystem paths), and whether a turn is
// active — none of which should be readable unauthenticated.
export function createStatusRoutes(deps: StatusDeps): Hono {
  return new Hono().get("/status", (c) => {
    return c.json({
      healthy: true,
      uptime: Date.now() - startTime,
      version: deps.sourceCommit,
      cronJobs: deps.getCronStatus(),
      activeSession: deps.isTurnActive(),
    });
  });
}
