/**
 * The activity runtime: everything the activity record needs to live inside
 * one app instance — store, live stream, notifier, push sender, the boot
 * orphan sweep, and the always-on lifecycle tick (stale sweep, notification
 * detection, push delivery, hourly prune). `createApp` constructs one and
 * wires its pieces into the host, routes, and bridge; `close()` releases the
 * interval and subscriptions.
 *
 * Nothing here may block boot or fail the observed work: the sweep and every
 * tick pass log and continue on failure.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { ActivityQuery, ActivityQueryResult } from "@schlessera/brain-ui-sdk/server";

import { createActivityStore, type ActivityStore, type RollupPricing } from "./store.js";
import { createActivityStream, type ActivityStream } from "./stream.js";
import { createActivityNotifier, type ActivityNotifier } from "./notify.js";
import { createPushSender, type PushSender } from "./push-sender.js";
import { digestRetentionFloor } from "./digest.js";
import { runActivityQuery } from "./query.js";
import { createRuntimeStatus, type RuntimeStatus } from "./runtime-status.js";
import { getDetailRetentionDays } from "../db/settings.js";

// Activity lifecycle cadence. The stale threshold must comfortably exceed
// the cron wrapper's heartbeat interval (~30s) so a live writer is never
// swept; the tick doubles as the always-on low-frequency sweep the
// notification layer extends.
const ACTIVITY_TICK_MS = 20_000;
const ACTIVITY_STALE_AFTER_MS = 2 * 60 * 1000;
const ACTIVITY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const ACTIVITY_HARD_CEILING_MS = 90 * 24 * 60 * 60 * 1000;
/** Acknowledged notification intents are kept this long, then deleted. */
const INTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ActivityRuntime {
  store: ActivityStore;
  stream: ActivityStream;
  notifier: ActivityNotifier;
  pushSender: PushSender;
  /** What the server knows about the agent runtime (boot probe, last turn, last auth failure). */
  runtime: RuntimeStatus;
  /** The agent-facing read seam (bridge.queryActivity). */
  query(query: ActivityQuery): ActivityQueryResult;
  close(): void;
}

export function createActivityRuntime(
  db: Database,
  deps: {
    log: Logger;
    /**
     * The app's shared model-pricing instance, for rollup-time effective
     * cost. Optional so embedders without one fall back to the store's own
     * env-derived default (the same instance shape, just not shared).
     */
    pricing?: RollupPricing;
  }
): ActivityRuntime {
  const { log } = deps;
  const store = createActivityStore(db, deps.pricing ? { pricing: deps.pricing } : {});
  const stream = createActivityStream(store, log);

  // The notifier resumes its persisted cursor, including terminal changes
  // committed while this server was down and interruptions from the boot sweep.
  const notifier = createActivityNotifier({
    db,
    store,
    isWatched: (scope) => stream.isWatched(scope),
    log,
  });
  const pushSender = createPushSender(db, { log });

  // Boot sweep: close this server's orphans from a previous life (interrupted).
  try {
    const orphans = store.sweepOwnOrphans();
    if (orphans > 0) {
      log.emit({
        severityText: "WARN",
        body: "closed orphaned activity spans from a previous process",
        attributes: { count: orphans },
      });
    }
  } catch (err) {
    log.emit({
      severityText: "WARN",
      body: "boot activity sweep failed",
      attributes: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  let delivering = false;
  let lastPrune = 0;
  const tick = setInterval(() => {
    try {
      const stale = store.sweepStale(ACTIVITY_STALE_AFTER_MS);
      if (stale > 0) {
        log.emit({
          severityText: "WARN",
          body: "closed stale activity spans (writer went silent)",
          attributes: { count: stale },
        });
        stream.pump();
      }
      notifier.tick();
      // Async delivery, reentrancy-guarded: a slow push service must not
      // stack passes; the next tick simply retries what stayed pending.
      if (!delivering) {
        delivering = true;
        void pushSender
          .deliverPending(notifier)
          .catch((err) =>
            log.emit({
              severityText: "WARN",
              body: "push delivery pass failed",
              attributes: { error: err instanceof Error ? err.message : String(err) },
            })
          )
          .finally(() => {
            delivering = false;
          });
      }
      if (Date.now() - lastPrune > ACTIVITY_PRUNE_INTERVAL_MS) {
        lastPrune = Date.now();
        // Self-heal the pricing table on server traffic: without this, a
        // long-lived server rolls up from whatever the boot-time refresh
        // fetched. Single-flight + TTL inside ensureFresh make the hourly
        // call free when fresh. The rollup path itself stays synchronous —
        // never refresh from inside the store.
        const pricing = deps.pricing as
          | { ensureFresh?: () => Promise<void> }
          | undefined;
        if (typeof pricing?.ensureFresh === "function") {
          void pricing.ensureFresh().catch(() => {});
        }
        store.prune({
          // Full detail survives until the digest has covered it AND the
          // retention window has passed; the hard ceiling bounds growth even
          // if the digest job silently dies. The setting is read every pass
          // so a change applies without a restart.
          digestFloorAt: digestRetentionFloor(db),
          detailRetentionMs: getDetailRetentionDays(db, log) * 24 * 60 * 60 * 1000,
          hardCeilingMs: ACTIVITY_HARD_CEILING_MS,
        });
        notifier.pruneAcknowledged(INTENT_RETENTION_MS);
      }
    } catch (err) {
      log.emit({
        severityText: "WARN",
        body: "activity tick failed",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }, ACTIVITY_TICK_MS);
  // A Bun interval would otherwise keep a closed test app's process alive.
  if (typeof tick === "object" && "unref" in tick) tick.unref();

  return {
    store,
    stream,
    notifier,
    pushSender,
    runtime: createRuntimeStatus(),
    query: (query) => runActivityQuery(db, store, query, notifier),
    close() {
      clearInterval(tick);
      stream.close();
    },
  };
}
