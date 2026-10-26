import { z } from "zod";
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Pressure, Refusal } from "./pressure.js";
import { hashScope, validateHistory, type Aggregate, type HistoryPayload } from "./history-model.js";
export interface HistoryState {
  version: 1; salt: string;
  lastPersistedAt: number; lastObservedAt: number; lastAttemptBucket: number | null;
  paused: "collection-unavailable" | "clock-reversal" | "history-owner-evidence-budget" | null;
  pressures: Pressure[];
  /** Restoring an old backup cannot revive authority to send its old episodes. */
  suppressedEpisodes: string[];
  scopeLimit: boolean;
}
export type StoredHistory = HistoryPayload<HistoryState>;
export type Pending = { kind: "aggregate"; value: Aggregate } | { kind: "failure"; at: number };
export interface StorageWriteReport { identity: string; rootScope: string; target: string; resource: Refusal["resource"]; at: number; outcome: "no-space" | "success" }
export const storageBrainKey = (brainPath: string) => hashScope(realpathSync(brainPath));
export function emptyHistory(): StoredHistory {
  return { metadata: { samples: {}, capacities: {}, state: { version: 1, salt: randomBytes(32).toString("hex"), lastPersistedAt: 0, lastObservedAt: 0, lastAttemptBucket: null, paused: null, pressures: [], suppressedEpisodes: [], scopeLimit: false } }, samples: [] };
}
const instant = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{32}$/);
const pressureSchema = z.object({
  identity: digest, rootScope: digest, severity: z.enum(["observed", "low", "critical"]),
  capacity: z.boolean(), forecast: z.boolean(), refusals: z.array(z.object({
    target: digest, resource: z.enum(["bytes", "quota", "inodes", "unknown"]), at: instant, successAt: instant.nullable(),
  }).strict()), at: instant, recoveryAt: instant.nullable(), episode: z.string().uuid().nullable(),
  resolvedEpisode: z.string().uuid().nullable(), supportAt: instant.nullable(), scopeChanged: z.boolean(),
}).strict().refine(value => (value.severity === "critical") === (value.episode !== null)
  && (value.severity !== "observed" || !value.capacity && !value.forecast && !value.refusals.length)
  && new Set(value.refusals.map(row => row.target + ":" + row.resource)).size === value.refusals.length);
export const stateSchema = z.object({
  version: z.literal(1), salt: z.string().regex(/^[a-f0-9]{64}$/), lastPersistedAt: instant,
  lastObservedAt: instant, lastAttemptBucket: instant.nullable(), paused: z.enum(["collection-unavailable", "clock-reversal", "history-owner-evidence-budget"]).nullable(),
  pressures: z.array(pressureSchema).max(4), suppressedEpisodes: z.array(z.string().uuid()).max(8), scopeLimit: z.boolean(),
}).strict().refine(value => new Set(value.pressures.map(row => row.identity)).size === value.pressures.length);
export function parseStoredHistory(value: string): StoredHistory {
  const result = JSON.parse(value) as StoredHistory;
  validateHistory(result);
  stateSchema.parse(result.metadata.state);
  return result;
}
export function readStoredHistory(db: Database, brain: string): StoredHistory | null {
  const row = db.query("SELECT payload_json FROM storage_history WHERE brain = ?").get(brain) as { payload_json: string } | null;
  return row ? parseStoredHistory(row.payload_json) : null;
}
