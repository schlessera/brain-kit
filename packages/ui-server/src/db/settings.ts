// Server-side settings: a JSON-per-key KV table (migration 006).
//
// These are deployment-wide preferences that must follow the user across
// devices, so they live in SQLite on the persisted volume rather than in the
// browser. Values are stored as JSON text; readers are total — a missing or
// corrupt row degrades to the caller's fallback rather than throwing, because
// a bad preference must never take a route down.

import type { Database } from "bun:sqlite";

const HIDDEN_MODELS_KEY = "models.hidden";

export function getSetting<T>(db: Database, key: string, fallback: T): T {
  const row = db
    .query("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    console.warn(`[settings] Corrupt JSON for "${key}"; using fallback`);
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
export function getHiddenModelIds(db: Database): string[] {
  const value = getSetting<unknown>(db, HIDDEN_MODELS_KEY, []);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

/** Replace the hidden set (the client always sends the full list, not a delta). */
export function setHiddenModelIds(db: Database, ids: string[]): void {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  setSetting(db, HIDDEN_MODELS_KEY, unique);
}
