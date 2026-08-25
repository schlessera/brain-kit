// Server-side settings: a JSON-per-key KV table (migration 006).
//
// These are deployment-wide preferences that must follow the user across
// devices, so they live in SQLite on the persisted volume rather than in the
// browser. Values are stored as JSON text; readers are total — a missing or
// corrupt row degrades to the caller's fallback rather than throwing, because
// a bad preference must never take a route down.

import type { Logger } from "@opentelemetry/api-logs";
import type { Database } from "bun:sqlite";
import { isBillingMode, type BillingMode } from "@schlessera/brain-ui-sdk/protocol";

const HIDDEN_MODELS_KEY = "models.hidden";
const BILLING_OVERRIDES_KEY = "models.billing";
const DETAIL_RETENTION_KEY = "activity.retention.detailDays";
const DETAIL_RETENTION_DEFAULT_DAYS = 7;

export function getSetting<T>(db: Database, key: string, fallback: T, log?: Logger): T {
  const row = db
    .query("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    log?.emit({
      severityText: "WARN",
      body: "corrupt JSON in settings; using fallback",
      attributes: { key },
    });
    return fallback;
  }
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), Date.now());
}

/** Profile ids the user keeps out of the model picker. */
export function getHiddenModelIds(db: Database, log?: Logger): string[] {
  const value = getSetting<unknown>(db, HIDDEN_MODELS_KEY, [], log);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

/** Replace the hidden set (the client always sends the full list, not a delta). */
export function setHiddenModelIds(db: Database, ids: string[]): void {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  setSetting(db, HIDDEN_MODELS_KEY, unique);
}

/**
 * Per-profile billing-mode overrides: profile id → forced classification. A
 * profile absent from the record is "auto" (the registry's derived mode
 * applies). Anything that is not exactly "subscription" or "api" is dropped
 * on read, so a corrupt row degrades to auto rather than misbilling.
 */
export function getBillingOverrides(
  db: Database,
  log?: Logger
): Record<string, BillingMode> {
  const value = getSetting<unknown>(db, BILLING_OVERRIDES_KEY, {}, log);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.create(null);
  }
  // Null-prototype: profile ids are user-supplied strings — an id like
  // "__proto__" must be an ordinary key, and a "constructor" lookup by a
  // consumer must not resolve a prototype member.
  const overrides: Record<string, BillingMode> = Object.create(null);
  for (const [profileId, mode] of Object.entries(value)) {
    if (isBillingMode(mode)) overrides[profileId] = mode;
  }
  return overrides;
}

/** Replace the override record (the client always sends the full record, not a delta). */
export function setBillingOverrides(
  db: Database,
  overrides: Record<string, BillingMode>
): void {
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(
      ([profileId, mode]) => profileId && isBillingMode(mode)
    )
  );
  setSetting(db, BILLING_OVERRIDES_KEY, clean);
}

/** Minimum days a finished run keeps its detail (spans/events) before the
 *  digest-covered prune may take it. 0 is valid (prune as soon as covered);
 *  anything non-numeric or negative degrades to the default. */
export function getDetailRetentionDays(db: Database, log?: Logger): number {
  const value = getSetting<unknown>(db, DETAIL_RETENTION_KEY, DETAIL_RETENTION_DEFAULT_DAYS, log);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DETAIL_RETENTION_DEFAULT_DAYS;
  }
  return value;
}

export function setDetailRetentionDays(db: Database, days: number): void {
  setSetting(db, DETAIL_RETENTION_KEY, days);
}
