import packageInfo from "@schlessera/brain-ui-server/package.json" with { type: "json" };
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import type { RuntimeStatusSnapshot } from "../activity/runtime-status.js";
import type { SubscriptionStatus } from "../agent/subscription.js";
import type { MetricSnapshot } from "../observability/index.js";

const startTime = Date.now();

// Public liveness probe. Deliberately minimal: no version/commit, no cron
// detail, no session oracle — this route sits in front of the auth guard and
// is reachable by anyone on the origin.
//
// "Healthy" means the app's own SQLite handle answers a real read, not merely
// that the process accepts connections: the Docker healthcheck gates on this
// route, and a wedged database previously kept reporting healthy while every
// stateful route failed. The probe reads sqlite_master rather than a bare
// SELECT 1 — a constant expression touches no page of the database file, so it
// cannot notice a locked or corrupted one. The unhealthy body carries no
// detail — the route is public.
export function createHealthRoutes(deps: { db: Database }): Hono {
  return new Hono().get("/health", (c) => {
    try {
      deps.db.query("SELECT name FROM sqlite_master LIMIT 1").get();
    } catch {
      return c.json({ status: "unhealthy" }, 503);
    }
    return c.json({
      status: "healthy",
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  });
}

export interface StatusDeps {
  /** Git SHA baked at build time (SOURCE_COMMIT), "dev" when unset. */
  sourceCommit: string;
  getCronStatus(): unknown;
  isTurnActive(): boolean;
  /** Recorded counters; undefined when the consumer cannot be read back. */
  getMetrics?(): MetricSnapshot | undefined;
  /** What the server knows about the agent runtime (#211). */
  getRuntime?(): RuntimeStatusSnapshot;
  /** The Claude subscription token: expiry, last proof, last failure (#254). */
  getSubscription?(): Promise<SubscriptionStatus>;
}

// Operational status. Registered BEHIND the auth guard: it exposes the git SHA,
// cron job errors (raw stderr with filesystem paths), and whether a turn is
// active — none of which should be readable unauthenticated.
export function createStatusRoutes(deps: StatusDeps): Hono {
  return new Hono().get("/status", async (c) => {
    const subscription = deps.getSubscription ? await deps.getSubscription() : undefined;
    return c.json({
      healthy: true,
      uptime: Date.now() - startTime,
      version: deps.sourceCommit,
      software: { release: packageInfo.version, sourceCommit: deps.sourceCommit },
      cronJobs: deps.getCronStatus(),
      activeSession: deps.isTurnActive(),
      // Counters the server recorded this process lifetime — dropped frames,
      // handler failures. Behind the auth guard with everything else here.
      metrics: deps.getMetrics?.() ?? [],
      // The runtime version, whether it is the measured one, the billing mode
      // the last turn actually ran on, and the last auth failure. Here and not
      // on /health: the version is operational detail, and /health is public.
      ...(deps.getRuntime ? { runtime: deps.getRuntime() } : {}),
      // Whether the subscription token is set, when it expires, when it last
      // worked, and what to do about the last auth failure. Never the token.
      ...(subscription ? { subscription } : {}),
    });
  });
}
