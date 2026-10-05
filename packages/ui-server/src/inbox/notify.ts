/**
 * Durable Action notices (U9): counted pushes for waiting decisions and the
 * Actions/FYI contribution to the in-app digest, under the maintainer's
 * 2026-10-02 policy in `docs/decisions/action-notifications.md`.
 *
 * Every notice deep-links into the existing Actions destination; it grants no
 * authority and never resolves an Action. Records live in the operational UI
 * database (migration 030), so they survive restart and the operational
 * backup. Persisted instants come from the server clock; a client only
 * reports the IANA zone its civil-time schedules use.
 *
 * - Episodes start when a decision becomes pending (new Action or explicit
 *   snooze reactivation). The store records them inside the transition.
 * - `enroll()` places push-eligible episodes (score >= 12, zero attempts) into
 *   a fixed 60-second window per recipient principal. Later arrivals join
 *   without moving the deadline; arrivals at or after it open the next window.
 * - `beginAttempt()` recomputes current eligibility, authority and the
 *   destination's local quiet hours in one transaction, then freezes the
 *   attempt's payload and components before anything is sent.
 * - `digest()` stores one current summary per client context and 09:00/17:00
 *   local slot, committing its coverage atomically with the summary.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ActionDigestState,
  ActionDigestSummary,
  InboxActionItem,
  InboxItem,
} from "@schlessera/brain-ui-sdk/protocol";
import { inboxItemSchema } from "@schlessera/brain-ui-sdk/schemas";

import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { inboxPriority } from "./state.js";

export type { ActionDigestState, ActionDigestSummary } from "@schlessera/brain-ui-sdk/protocol";

/** Fixed batching window from the first eligible arrival. */
export const ACTION_NOTICE_WINDOW_MS = 60_000;
/** Inclusive push cutoff on the existing priority score with zero attempts. */
export const ACTION_PUSH_CUTOFF = 12;
/** Strict local quiet interval [22:00, 08:00), retries included. */
export const ACTION_QUIET_START_HOUR = 22;
export const ACTION_QUIET_END_HOUR = 8;
/** Local in-app digest refresh slots. */
export const ACTION_DIGEST_HOURS = [9, 17] as const;
/** The existing push retry discipline: three attempts, five-minute backoff. */
export const ACTION_MAX_SEND_ATTEMPTS = 3;
export const ACTION_SEND_RETRY_BACKOFF_MS = 5 * 60 * 1000;
/** An in-flight attempt older than this is treated as an ambiguous outcome. */
export const ACTION_IN_FLIGHT_STALE_MS = 60_000;
/** The Actions destination, the route the existing push contract uses. */
export const ACTION_NOTICE_URL = "/#/activity";
export const ACTION_NOTICE_TAG = "brain-actions";


export type ActionAttemptOutcome = "success" | "failed" | "ambiguous" | "gone";

export interface ActionNoticePayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export interface ActionAttempt {
  attemptId: number;
  count: number;
  payload: ActionNoticePayload;
}

export interface ActionNotifier {
  /** Join newly push-eligible episodes to their recipient's fixed window. */
  enroll(now?: number): number;
  /** Recompute and freeze one destination's next attempt, or null when none is due. */
  beginAttempt(destination: { endpoint: string; principalId: string }, now?: number): ActionAttempt | null;
  /** Settle an in-flight attempt exactly once. */
  finishAttempt(attemptId: number, outcome: ActionAttemptOutcome, now?: number): void;
  /** Record a client's reported zone; unusable metadata is stored as missing. */
  reportZone(principalId: string, timeZone: unknown, endpoint?: string, now?: number): { timeZone: string | null };
  /** Generate this context's due summary if needed, then return the latest. */
  digest(principalId: string, now?: number): ActionDigestState;
  /** Generate due summaries for every usable client context. */
  generateDue(now?: number): number;
}

/** A canonical IANA name the runtime's own zone database accepts, or null. */
export function noticeTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(zone, format);
  }
  return format;
}

/** Local wall-clock reading of an instant, expressed as a UTC timestamp. */
function wallClock(zone: string, at: number): number {
  const parts = formatter(zone).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

export function localHour(zone: string, at: number): number {
  return new Date(wallClock(zone, at)).getUTCHours();
}

export function inQuietHours(zone: string, at: number): boolean {
  const hour = localHour(zone, at);
  return hour >= ACTION_QUIET_START_HOUR || hour < ACTION_QUIET_END_HOUR;
}

/** The UTC instant of a local wall-clock time, following the zone's offset rules. */
function zonedInstant(zone: string, wall: number): number {
  let utc = wall;
  for (let i = 0; i < 4; i++) {
    const delta = wall - wallClock(zone, utc);
    if (delta === 0) return utc;
    utc += delta;
  }
  return utc;
}

/** The most recent local 09:00 or 17:00 at or before `at`. */
export function latestDigestSlot(zone: string, at: number): number {
  const today = new Date(wallClock(zone, at));
  let best = -Infinity;
  for (const dayOffset of [0, -1]) {
    for (const hour of ACTION_DIGEST_HOURS) {
      const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + dayOffset, hour);
      const instant = zonedInstant(zone, wall);
      if (instant <= at && instant > best) best = instant;
    }
  }
  return best;
}

/** History identifies a device by digest, never by its capability URL. */
export function noticeDestination(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function actionNoticePayload(count: number): ActionNoticePayload {
  // Lock-screen minimization: a count and navigation, nothing from the thread.
  return {
    title: count === 1 ? "1 action waiting" : `${count} actions waiting`,
    body: "Open Actions to decide.",
    tag: ACTION_NOTICE_TAG,
    url: ACTION_NOTICE_URL,
  };
}

interface EpisodeRow {
  id: string;
  item_id: string;
  thread_id: string;
  ordinal: number;
  started_at: number;
  ended_at: number | null;
}

/**
 * Called by the store inside the transaction that changes an Action's status.
 * Only a transition INTO pending starts an episode; leaving pending ends it.
 */
export function recordActionEpisode(
  db: Database,
  item: InboxItem,
  from: string | null,
  now: number
): void {
  if (item.queue !== "actions" || item.type === "fyi" || from === item.status) return;
  if (item.status === "pending") {
    const { next } = db
      .query("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM inbox_notice_episodes WHERE item_id = ?")
      .get(item.id) as { next: number };
    db.query("UPDATE inbox_notice_episodes SET ended_at = ? WHERE item_id = ? AND ended_at IS NULL").run(now, item.id);
    db.query(
      "INSERT INTO inbox_notice_episodes (id, item_id, thread_id, ordinal, started_at) VALUES (?, ?, ?, ?, ?)"
    ).run(`${item.id}#${next}`, item.id, item.threadId, next, now);
  } else if (from === "pending") {
    db.query("UPDATE inbox_notice_episodes SET ended_at = ? WHERE item_id = ? AND ended_at IS NULL").run(now, item.id);
  }
}

interface Current {
  action: InboxActionItem;
  score: number;
}

/**
 * The current state of an episode's Action, read inside the caller's
 * transaction: pending (not snoozed), unexpired, undeleted, in an open thread,
 * and still the episode the Action is in. Anything else is ineligible.
 */
function currentDecision(db: Database, episode: EpisodeRow, now: number): Current | null {
  if (episode.ended_at !== null) return null;
  const row = db
    .query("SELECT data_json, deleted_at FROM inbox_items WHERE id = ?")
    .get(episode.item_id) as { data_json: string; deleted_at: number | null } | null;
  if (!row || row.deleted_at !== null) return null;
  const item = inboxItemSchema.parse(JSON.parse(row.data_json));
  if (item.queue !== "actions" || item.type === "fyi" || item.status !== "pending" || item.expiresAt <= now) return null;
  const thread = db
    .query("SELECT stakes, deadline, status, deleted_at FROM inbox_threads WHERE id = ?")
    .get(item.threadId) as { stakes: number; deadline: number | null; status: string; deleted_at: number | null } | null;
  if (!thread || thread.status !== "open" || thread.deleted_at !== null) return null;
  // Actions carry zero attempts in the existing formula.
  const score = inboxPriority(thread.stakes, thread.deadline ?? undefined, item.createdAt, 0, now);
  return { action: item, score };
}

function usable(db: Database, principalId: string | null, now: number): boolean {
  if (!principalId) return false;
  const principal = resolvePrincipal(db, principalId);
  return !!principal && isUsablePrincipal(principal, now);
}

function restorePending(db: Database): boolean {
  return !!db.query("SELECT 1 FROM inbox_recovery_state WHERE status = 'pending'").get();
}

function openEpisodes(db: Database): EpisodeRow[] {
  return db.query("SELECT * FROM inbox_notice_episodes WHERE ended_at IS NULL ORDER BY started_at, id").all() as EpisodeRow[];
}

export function createActionNotifier(db: Database, options: { now?: () => number } = {}): ActionNotifier {
  const clock = options.now ?? Date.now;
  const write = <T>(fn: () => T): T => db.transaction(fn).immediate();

  function recipients(now: number): string[] {
    // Recipient principals are the usable owners of bound push destinations.
    const rows = db
      .query(
        `SELECT DISTINCT s.principal_id AS id FROM push_subscriptions s
         JOIN principals p ON p.id = s.principal_id
         WHERE p.revoked_at IS NULL AND typeof(p.expires_at) = 'integer' AND p.expires_at > ?
         ORDER BY s.principal_id`
      )
      .all(now) as { id: string }[];
    return rows.map((row) => row.id).filter((id) => usable(db, id, now));
  }

  function generate(principalId: string, now: number): ActionDigestState {
    return write(() => {
      const context = db
        .query("SELECT time_zone FROM inbox_notice_clients WHERE principal_id = ?")
        .get(principalId) as { time_zone: string | null } | null;
      const zone = noticeTimeZone(context?.time_zone);
      if (!zone) return { status: "zone_required" };
      const latest = () => {
        const row = db
          .query("SELECT summary_json FROM inbox_notice_digests WHERE principal_id = ? ORDER BY slot_at DESC, id DESC LIMIT 1")
          .get(principalId) as { summary_json: string } | null;
        return row ? (JSON.parse(row.summary_json) as ActionDigestSummary) : null;
      };
      if (!usable(db, principalId, now) || restorePending(db)) return { status: "ready", timeZone: zone, latest: latest() };
      const slot = latestDigestSlot(zone, now);
      const last = db
        .query("SELECT MAX(slot_at) AS slot FROM inbox_notice_digests WHERE principal_id = ?")
        .get(principalId) as { slot: number | null };
      // One current summary per slot. Missed slots are not replayed: the next
      // opportunity covers every unreported item regardless of its age.
      if (last.slot !== null && last.slot >= slot) return { status: "ready", timeZone: zone, latest: latest() };

      const covered = db.query(
        "SELECT 1 FROM inbox_notice_coverage WHERE principal_id = ? AND subject_kind = ? AND subject_id = ?"
      );
      const waiting: ActionDigestSummary["waiting"] = [];
      for (const episode of openEpisodes(db)) {
        const current = currentDecision(db, episode, now);
        if (!current || current.score >= ACTION_PUSH_CUTOFF) continue;
        if (covered.get(principalId, "episode", episode.id)) continue;
        waiting.push({ episodeId: episode.id, itemId: current.action.id, threadId: current.action.threadId, title: current.action.payload.title });
      }
      const updates: ActionDigestSummary["updates"] = [];
      const fyis = db
        .query(
          `SELECT i.data_json FROM inbox_items i JOIN inbox_threads t ON t.id = i.thread_id
           WHERE i.queue = 'actions' AND i.type = 'fyi' AND i.status = 'pending' AND i.deleted_at IS NULL
             AND i.expires_at > ? AND t.deleted_at IS NULL ORDER BY i.rowid`
        )
        .all(now) as { data_json: string }[];
      for (const row of fyis) {
        const item = inboxItemSchema.parse(JSON.parse(row.data_json)) as InboxActionItem;
        if (covered.get(principalId, "fyi", item.id)) continue;
        updates.push({ itemId: item.id, threadId: item.threadId, title: item.payload.title });
      }
      const summary: ActionDigestSummary = { generatedAt: now, slotAt: slot, timeZone: zone, waiting, updates };
      const { id } = db
        .query(
          "INSERT INTO inbox_notice_digests (principal_id, slot_at, time_zone, generated_at, summary_json) VALUES (?, ?, ?, ?, ?) RETURNING id"
        )
        .get(principalId, slot, zone, now, JSON.stringify(summary)) as { id: number };
      const cover = db.query(
        "INSERT INTO inbox_notice_coverage (principal_id, subject_kind, subject_id, digest_id) VALUES (?, ?, ?, ?)"
      );
      for (const entry of waiting) cover.run(principalId, "episode", entry.episodeId, id);
      for (const entry of updates) cover.run(principalId, "fyi", entry.itemId, id);
      return { status: "ready", timeZone: zone, latest: summary };
    });
  }

  return {
    enroll(at) {
      const now = at ?? clock();
      return write(() => {
        if (restorePending(db)) return 0;
        const principals = recipients(now);
        if (principals.length === 0) return 0;
        const joined = db.query("SELECT 1 FROM inbox_notice_constituents WHERE principal_id = ? AND episode_id = ?");
        const open = db.query(
          "SELECT id FROM inbox_notice_batches WHERE principal_id = ? AND opened_at <= ? AND due_at > ? ORDER BY id DESC LIMIT 1"
        );
        let added = 0;
        for (const episode of openEpisodes(db)) {
          const current = currentDecision(db, episode, now);
          if (!current || current.score < ACTION_PUSH_CUTOFF) continue;
          for (const principalId of principals) {
            if (joined.get(principalId, episode.id)) continue;
            let batch = open.get(principalId, now, now) as { id: number } | null;
            if (!batch) {
              batch = db
                .query(
                  "INSERT INTO inbox_notice_batches (principal_id, channel, delivery_class, opened_at, due_at) VALUES (?, 'push', 'push', ?, ?) RETURNING id"
                )
                .get(principalId, now, now + ACTION_NOTICE_WINDOW_MS) as { id: number };
            }
            db.query(
              "INSERT INTO inbox_notice_constituents (batch_id, episode_id, principal_id, item_id, thread_id, joined_at) VALUES (?, ?, ?, ?, ?, ?)"
            ).run(batch.id, episode.id, principalId, episode.item_id, episode.thread_id, now);
            added++;
          }
        }
        return added;
      });
    },

    beginAttempt(destination, at) {
      const now = at ?? clock();
      return write(() => {
        if (restorePending(db)) return null;
        const sub = db
          .query("SELECT principal_id, time_zone FROM push_subscriptions WHERE endpoint = ?")
          .get(destination.endpoint) as { principal_id: string | null; time_zone: string | null } | null;
        // Authority is the subscription's CURRENT binding, rechecked here.
        if (!sub || sub.principal_id !== destination.principalId || !usable(db, sub.principal_id, now)) return null;
        // Missing or unusable zone metadata: visibly pending, no server-time fallback.
        const zone = noticeTimeZone(sub.time_zone);
        if (!zone || inQuietHours(zone, now)) return null;
        const dest = noticeDestination(destination.endpoint);
        const inFlight = db
          .query("SELECT 1 FROM inbox_notice_attempts WHERE destination = ? AND outcome = 'in_flight' AND attempted_at > ?")
          .get(dest, now - ACTION_IN_FLIGHT_STALE_MS);
        if (inFlight) return null;

        const due = db
          .query(
            `SELECT c.batch_id, c.episode_id FROM inbox_notice_constituents c
             JOIN inbox_notice_batches b ON b.id = c.batch_id
             WHERE c.principal_id = ? AND b.due_at <= ?
             ORDER BY b.due_at, c.joined_at, c.episode_id`
          )
          .all(sub.principal_id, now) as { batch_id: number; episode_id: string }[];
        const history = db.query(
          `SELECT a.outcome, a.attempted_at FROM inbox_notice_attempt_components ac
           JOIN inbox_notice_attempts a ON a.id = ac.attempt_id
           WHERE ac.episode_id = ? AND a.destination = ?`
        );
        const episode = db.query("SELECT * FROM inbox_notice_episodes WHERE id = ?");
        const components: { batch_id: number; episode_id: string }[] = [];
        const seen = new Set<string>();
        for (const row of due) {
          if (seen.has(row.episode_id)) continue;
          seen.add(row.episode_id);
          const current = currentDecision(db, episode.get(row.episode_id) as EpisodeRow, now);
          if (!current || current.score < ACTION_PUSH_CUTOFF) continue;
          const past = history.all(row.episode_id, dest) as { outcome: string; attempted_at: number }[];
          // At most one known successful submission per episode per destination.
          if (past.some((p) => p.outcome === "success")) continue;
          // Bounded retry: every unsuccessful attempt, ambiguous ones included,
          // spends budget and waits out the existing backoff.
          if (past.length >= ACTION_MAX_SEND_ATTEMPTS) continue;
          if (past.some((p) => p.attempted_at > now - ACTION_SEND_RETRY_BACKOFF_MS)) continue;
          components.push(row);
        }
        if (components.length === 0) return null;
        const payload = actionNoticePayload(components.length);
        const { id } = db
          .query(
            "INSERT INTO inbox_notice_attempts (destination, principal_id, attempted_at, outcome, count, payload_json) VALUES (?, ?, ?, 'in_flight', ?, ?) RETURNING id"
          )
          .get(dest, sub.principal_id, now, components.length, JSON.stringify(payload)) as { id: number };
        const insert = db.query(
          "INSERT INTO inbox_notice_attempt_components (attempt_id, episode_id, batch_id) VALUES (?, ?, ?)"
        );
        for (const component of components) insert.run(id, component.episode_id, component.batch_id);
        return { attemptId: id, count: components.length, payload };
      });
    },

    finishAttempt(attemptId, outcome, at) {
      const now = at ?? clock();
      db.query("UPDATE inbox_notice_attempts SET outcome = ?, settled_at = ? WHERE id = ? AND outcome = 'in_flight'")
        .run(outcome, now, attemptId);
    },

    reportZone(principalId, timeZone, endpoint, at) {
      const now = at ?? clock();
      const zone = noticeTimeZone(timeZone);
      return write(() => {
        if (!usable(db, principalId, now)) throw new Error("Authentication required");
        db.query(
          `INSERT INTO inbox_notice_clients (principal_id, time_zone, reported_at) VALUES (?, ?, ?)
           ON CONFLICT(principal_id) DO UPDATE SET time_zone = excluded.time_zone, reported_at = excluded.reported_at`
        ).run(principalId, zone, now);
        if (endpoint !== undefined) {
          // Only the caller's own destination; a zone never rebinds an endpoint.
          db.query(
            "UPDATE push_subscriptions SET time_zone = ?, time_zone_reported_at = ? WHERE endpoint = ? AND principal_id = ?"
          ).run(zone, now, endpoint, principalId);
        }
        return { timeZone: zone };
      });
    },

    digest(principalId, at) {
      return generate(principalId, at ?? clock());
    },

    generateDue(at) {
      const now = at ?? clock();
      const contexts = db
        .query("SELECT principal_id FROM inbox_notice_clients WHERE time_zone IS NOT NULL ORDER BY principal_id")
        .all() as { principal_id: string }[];
      let generated = 0;
      for (const { principal_id } of contexts) {
        if (!usable(db, principal_id, now)) continue;
        const before = db.query("SELECT COUNT(*) AS n FROM inbox_notice_digests WHERE principal_id = ?").get(principal_id) as { n: number };
        generate(principal_id, now);
        const after = db.query("SELECT COUNT(*) AS n FROM inbox_notice_digests WHERE principal_id = ?").get(principal_id) as { n: number };
        generated += after.n - before.n;
      }
      return generated;
    },
  };
}
