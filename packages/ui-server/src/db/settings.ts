// Server-side settings: a JSON-per-key KV table (migration 006).
//
// These are deployment-wide preferences that must follow the user across
// devices, so they live in SQLite on the persisted volume rather than in the
// browser. Values are stored as JSON text; readers are total — a missing or
// corrupt row degrades to the caller's fallback rather than throwing, because
// a bad preference must never take a route down.

import type { Logger } from "@opentelemetry/api-logs";
import type { Database } from "bun:sqlite";
import {
  isBillingMode,
  isThinkingLevel,
  type BillingMode,
  type ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";

const HIDDEN_MODELS_KEY = "models.hidden";
const BILLING_OVERRIDES_KEY = "models.billing";
const DEFAULT_MODEL_KEY = "models.default";
const CUSTOM_OPENROUTER_KEY = "models.customOpenRouter";
const THINKING_OVERRIDES_KEY = "models.thinking";
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

/**
 * The user's chosen default model profile, used when a turn names none (new
 * conversations from a fresh client, shares, host-initiated actions). Null =
 * auto (a connected subscription-auth profile, else the default backend's
 * own default).
 */
export function getDefaultModelId(db: Database, log?: Logger): string | null {
  const value = getSetting<unknown>(db, DEFAULT_MODEL_KEY, null, log);
  return typeof value === "string" && value ? value : null;
}

export function setDefaultModelId(db: Database, id: string | null): void {
  setSetting(db, DEFAULT_MODEL_KEY, id);
}

/** User-managed OpenRouter model ids (e.g. "z.ai/glm-5.3-flash"). */
export function getCustomOpenRouterModels(db: Database, log?: Logger): string[] {
  const value = getSetting<unknown>(db, CUSTOM_OPENROUTER_KEY, [], log);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Replace the custom OpenRouter list (full list, not a delta). */
export function setCustomOpenRouterModels(db: Database, models: string[]): void {
  const unique = [...new Set(models.filter((id) => typeof id === "string" && id))];
  setSetting(db, CUSTOM_OPENROUTER_KEY, unique);
}

/**
 * Per-profile reasoning-effort overrides: profile id → forced level. A
 * profile absent from the record keeps its configured default. Invalid
 * levels are dropped on read (same degradation discipline as billing).
 */
export function getThinkingOverrides(
  db: Database,
  log?: Logger
): Record<string, ThinkingLevel> {
  const value = getSetting<unknown>(db, THINKING_OVERRIDES_KEY, {}, log);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.create(null);
  }
  const overrides: Record<string, ThinkingLevel> = Object.create(null);
  for (const [profileId, level] of Object.entries(value)) {
    if (isThinkingLevel(level)) overrides[profileId] = level;
  }
  return overrides;
}

/** Replace the override record (the client always sends the full record, not a delta). */
export function setThinkingOverrides(
  db: Database,
  overrides: Record<string, ThinkingLevel>
): void {
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(
      ([profileId, level]) => profileId && isThinkingLevel(level)
    )
  );
  setSetting(db, THINKING_OVERRIDES_KEY, clean);
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
