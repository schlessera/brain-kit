import packageInfo from "@schlessera/brain-ui-server/package.json" with { type: "json" };
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import type { ContentRendererDeclaration } from "@schlessera/brain-ui-sdk";
import type { WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";

import type { AppEnv } from "../app-env.js";
import type { RuntimeStatusSnapshot } from "../activity/runtime-status.js";
import type { BackendBootFailure } from "../agent/backend.js";
import type { SafetyRecordingStatus, SafetyRecovery } from "../governance/safety-store.js";
import { requireJson } from "../middleware/origin.js";
import { requireOwner } from "../middleware/require-owner.js";
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
export function createHealthRoutes(deps: { db: Database; degradedReasons?(): string[] }): Hono {
  return new Hono().get("/health", (c) => {
    try {
      deps.db.query("SELECT name FROM sqlite_master LIMIT 1").get();
    } catch {
      return c.json({ status: "unhealthy" }, 503);
    }
    const reasons = deps.degradedReasons?.() ?? [];
    return c.json({
      status: reasons.length ? "degraded" : "healthy",
      ...(reasons.length ? { reasons } : {}),
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  });
}

interface StatusDeps {
  getBackendAvailability?(): { unavailable: BackendBootFailure[]; lastFailures: BackendBootFailure[] };
  /** Trusted metadata from configured modules; absent with an older CLI. */
  getContentRenderers?(signal?: AbortSignal): Promise<ContentRendererDeclaration[] | undefined>;
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
  /** Re-runs the boot's worker host probes and returns what they recorded (#1632). */
  checkWorkerHost?(): WorkerHostStatus | Promise<WorkerHostStatus>;
  /** The brain-wide safety recorder: latched, since, reason, first cause (#3810). Owner only. */
  getSafetyRecording?(): SafetyRecordingStatus;
  /** Owner fallback for automatic safety-recording recovery (#3810). */
  recoverSafetyRecording?(actor: string): SafetyRecovery;
}

// Operational status. Registered BEHIND the auth guard: it exposes the git SHA,
// cron job errors (raw stderr with filesystem paths), and whether a turn is
// active — none of which should be readable unauthenticated.
export function createStatusRoutes(deps: StatusDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get("/status", async (c) => {
    const backendAvailability = deps.getBackendAvailability?.();
    const subscription = deps.getSubscription ? await deps.getSubscription() : undefined;
    // The cause names a turn and an error's text: the owner's, not every principal's.
    let safetyRecording: SafetyRecordingStatus | undefined;
    if (deps.getSafetyRecording && c.get("principal")?.kind === "owner") {
      try { safetyRecording = deps.getSafetyRecording(); } catch { safetyRecording = undefined; }
    }
    const contentRenderers = await deps.getContentRenderers?.(c.req.raw.signal).catch(() => undefined);
    return c.json({
      ...(contentRenderers !== undefined ? { contentRenderers } : {}),
      healthy: !backendAvailability?.unavailable.length,
      ...(backendAvailability ? { backendAvailability } : {}),
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
      ...(safetyRecording ? { safetyRecording } : {}),
    });
  }).post("/status/worker-host", async (c) => {
    // "Check again" (#1632): re-runs the real probes the boot ran and answers
    // with what they recorded, the same object /status carries as
    // `runtime.workerHost`. Behind the guard like /status. It admits nothing:
    // every turn still runs its own probe.
    if (!deps.checkWorkerHost) return c.json({ error: "Not found" }, 404);
    return c.json(await deps.checkWorkerHost());
  }).post("/status/safety-recording/recover", requireOwner(), requireJson(), (c) => {
    // Runs the same recovery the host runs by itself, with its preconditions:
    // it refuses, changing nothing, while any safety producer is open.
    if (!deps.recoverSafetyRecording) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "no-store");
    try {
      const recovery = deps.recoverSafetyRecording(c.get("principal")!.id);
      return c.json({ recovery, safetyRecording: deps.getSafetyRecording?.() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ code: /producers/.test(message) ? "producers_open" : "unavailable", message, retryable: true }, 409);
    }
  });
}
