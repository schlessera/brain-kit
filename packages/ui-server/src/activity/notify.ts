/**
 * Notification intents: the at-least-once layer between the activity record
 * and every delivery channel.
 *
 * An intent is persisted when the triggering condition is DETECTED (a
 * terminal failure span, a stuck run) and carries its own lifecycle:
 * pending -> sent | send_failed | suppressed. The in-app inbox is the
 * guaranteed tier — it lists unacknowledged intents regardless of delivery
 * status — and web push (the accelerator) marks sent/send_failed on top.
 * Undelivered intents survive restarts by construction; the boot/tick sweep
 * simply finds them still pending.
 *
 * Detection runs on the server's always-on tick with its OWN change-log
 * cursor (the live stream's cursor only advances for subscribers), so a
 * foreign writer's failure — the cron wrapper recording an error while
 * nobody watches — is noticed within one tick, not at the next app open.
 *
 * Storm safety: a run-scoped tag deduplicates (one active intent per tag),
 * per-job debounce collapses repeats, and a global creation rate cap stops
 * one bad API key from paging for every job at once.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import { isFailureOutcome } from "@schlessera/brain-ui-sdk/protocol";

import { getSetting } from "../db/settings.js";
import type { ActivityStore, SpanRow } from "./store.js";

export type IntentKind = "failure" | "completion" | "stuck";

export interface NotificationIntent {
  id: number;
  runId: string;
  spanId: string | null;
  kind: IntentKind;
  tag: string;
  title: string;
  body: string;
  status: "pending" | "sent" | "send_failed" | "suppressed";
  acknowledged: boolean;
  createdAt: number;
}

export interface ActivityNotifierDeps {
  db: Database;
  store: ActivityStore;
  /** Was anyone watching this run/session when the event was recorded? */
  isWatched: (scope: { runId?: string; sessionId?: string }) => boolean;
  log?: Logger;
}

export interface ActivityNotifier {
  /** Detect new terminal failures + stuck runs; create intents. */
  tick(now?: number): void;
  /** Unacknowledged intents, newest first (the inbox). */
  inbox(limit?: number): NotificationIntent[];
  /** Intents awaiting delivery (the push sender's queue). */
  pending(limit?: number): NotificationIntent[];
  markDelivered(id: number, status: "sent" | "send_failed"): void;
  acknowledge(id: number): boolean;
  acknowledgeAll(): number;
}

/** Global cap on intents CREATED per hour — failure-storm circuit. */
const MAX_INTENTS_PER_HOUR = 20;
/** Watchdog default: a live root run older than this is flagged as stuck. */
const DEFAULT_STUCK_THRESHOLD_MS = 45 * 60 * 1000;

export function createActivityNotifier(deps: ActivityNotifierDeps): ActivityNotifier {
  const { db, store, isWatched, log } = deps;
  let cursor = latestCursor(db);
  /** Runs already flagged as stuck this process lifetime (tag also guards). */
  const stuckFlagged = new Set<string>();

  function latestCursor(database: Database): number {
    const row = database
      .query("SELECT COALESCE(MAX(change_id), 0) AS hi FROM activity_changes")
      .get() as { hi: number };
    return row.hi;
  }

  function createIntent(input: {
    runId: string;
    spanId?: string;
    kind: IntentKind;
    tag: string;
    title: string;
    body: string;
    suppressed?: boolean;
  }): void {
    const now = Date.now();
    // Tag dedupe: one live (unacknowledged) intent per tag — repeats coalesce.
    const existing = db
      .query(
        "SELECT id FROM notification_intents WHERE tag = ? AND acknowledged = 0 LIMIT 1"
      )
      .get(input.tag);
    if (existing) return;
    // Global creation rate cap.
    const recent = db
      .query("SELECT COUNT(*) AS n FROM notification_intents WHERE created_at > ?")
      .get(now - 60 * 60 * 1000) as { n: number };
    const status =
      input.suppressed || recent.n >= MAX_INTENTS_PER_HOUR ? "suppressed" : "pending";
    db.query(
      `INSERT INTO notification_intents
         (run_id, span_id, kind, tag, title, body, status, acknowledged, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      input.runId,
      input.spanId ?? null,
      input.kind,
      input.tag,
      input.title,
      input.body,
      status,
      now,
      now
    );
    log?.emit({
      severityText: "INFO",
      body: "notification intent created",
      attributes: { kind: input.kind, tag: input.tag, status },
    });
  }

  function intentForSpan(span: SpanRow): void {
    if (span.parentSpanId) return;
    if (isFailureOutcome(span.outcome)) {
      const label = span.jobName ?? span.name;
      // "Unwatched" is evaluated when the failure is NOTICED — a live
      // subscription to the run or its session means the user saw it happen,
      // so the intent lands acknowledged-free but suppressed for delivery.
      const watched = isWatched({
        runId: span.runId,
        ...(span.sessionId ? { sessionId: span.sessionId } : {}),
      });
      // Payload minimization: name + outcome word only. Lock screens render
      // this outside the app's auth; detail is behind the tap-through.
      createIntent({
        runId: span.runId,
        spanId: span.spanId,
        kind: "failure",
        tag: `failure:${span.jobName ?? span.sessionId ?? span.runId}`,
        title: `${label} ${span.outcome === "interrupted" ? "was interrupted" : "failed"}`,
        body: "Open to see the run.",
        suppressed: watched,
      });
      return;
    }
    if (span.outcome === "success" && span.jobName) {
      // Completion notifications are opt-in per job.
      const optIn = getSetting<string[]>(db, "activity.notify.completions", [], log);
      if (optIn.includes(span.jobName)) {
        createIntent({
          runId: span.runId,
          spanId: span.spanId,
          kind: "completion",
          tag: `completion:${span.jobName}:${span.runId}`,
          title: `${span.jobName} completed`,
          body: "Open to see the run.",
        });
      }
    }
  }

  return {
    tick(now) {
      try {
        // New committed changes since our own cursor: terminal root spans
        // among them become intents (SQL-side filter + join in the store).
        // The head is read BEFORE the detection query so advancing past
        // non-terminal changes can never skip a terminal write committed
        // in between; a change seen twice is absorbed by the tag dedupe.
        const head = latestCursor(db);
        const rows = store.terminalRootChangesSince(cursor, 500);
        for (const { span } of rows) intentForSpan(span);
        const lastSeen = rows.length > 0 ? rows[rows.length - 1]!.changeId : cursor;
        cursor = rows.length === 500 ? lastSeen : Math.max(head, lastSeen);

        // Watchdog: an over-threshold LIVE root run is stuck — a signal, not
        // an outcome. Threshold from settings, per-job override supported.
        const defaultThreshold = getSetting<number>(
          db,
          "activity.watchdog.thresholdMs",
          DEFAULT_STUCK_THRESHOLD_MS,
          log
        );
        const overrides = getSetting<Record<string, number>>(
          db,
          "activity.watchdog.perJobMs",
          {},
          log
        );
        for (const span of store.findStuck(defaultThreshold, now)) {
          if (stuckFlagged.has(span.runId)) continue;
          const threshold = span.jobName ? (overrides[span.jobName] ?? defaultThreshold) : defaultThreshold;
          if ((now ?? Date.now()) - span.startedAt < threshold) continue;
          stuckFlagged.add(span.runId);
          createIntent({
            runId: span.runId,
            spanId: span.spanId,
            kind: "stuck",
            tag: `stuck:${span.runId}`,
            title: `${span.jobName ?? span.name} is taking unusually long`,
            body: "Still running. Open to check on it.",
          });
        }
      } catch (err) {
        log?.emit({
          severityText: "WARN",
          body: "notifier tick failed",
          attributes: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    },

    inbox(limit = 50) {
      return (
        db
          .query(
            "SELECT * FROM notification_intents WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT ?"
          )
          .all(limit) as any[]
      ).map(rowToIntent);
    },

    pending(limit = 20) {
      return (
        db
          .query(
            "SELECT * FROM notification_intents WHERE status = 'pending' ORDER BY created_at LIMIT ?"
          )
          .all(limit) as any[]
      ).map(rowToIntent);
    },

    markDelivered(id, status) {
      db.query("UPDATE notification_intents SET status = ?, updated_at = ? WHERE id = ?").run(
        status,
        Date.now(),
        id
      );
    },

    acknowledge(id) {
      const res = db
        .query("UPDATE notification_intents SET acknowledged = 1, updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
      return res.changes > 0;
    },

    acknowledgeAll() {
      const res = db
        .query("UPDATE notification_intents SET acknowledged = 1, updated_at = ? WHERE acknowledged = 0")
        .run(Date.now());
      return res.changes;
    },
  };
}

function rowToIntent(r: any): NotificationIntent {
  return {
    id: r.id,
    runId: r.run_id,
    spanId: r.span_id,
    kind: r.kind,
    tag: r.tag,
    title: r.title,
    body: r.body,
    status: r.status,
    acknowledged: r.acknowledged === 1,
    createdAt: r.created_at,
  };
}
