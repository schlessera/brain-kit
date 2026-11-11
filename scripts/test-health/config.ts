/** Reads `config.json` and resolves one profile over the defaults. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Profile {
  name: string;
  /** The ref batches branch from and land on. The push wrapper passes its epic branch. */
  base: string;
  clusterSize: number;
  /** Files one run may audit; `null` means until nothing is left. */
  budgetFiles: number | null;
  /** Every Nth run takes the oldest-audit-first queue instead of the worst-first one. */
  sweepEvery: number;
  claimHours: number;
  reauditDays: number;
  /** A package with at most this many test files in the profile's tiers shares the `small` group; `null` gives every package its own. */
  smallPackageFiles: number | null;
  /** Largest prepared patch `record cluster --wip` stores on the ledger. */
  wipMaxBytes: number;
  /** How far past its time budget a run may go to prove a fix it already wrote. */
  proofOverrunMinutes: number;
  tiers: string[];
  ripe: { changedFiles: number | null; ageHours: number | null; maxChangedFiles: number | null; whenExhausted: boolean };
  landing: { maxOpenCandidates: number | null; maxPerDay: number | null };
  backlog: { maxParkedChangedFiles: number | null };
  weights: { cost: number; issues: number; signals: number; neverAudited: number };
  measure: { runs: number; stableRuns: number; budgetSeconds: number; heavySeconds: number };
}

export interface Config { ledgerRemote: string; ledgerRef: string; profile: Profile }

export const CONFIG_FILE = join(import.meta.dir, "config.json");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Objects merge key by key; anything else, `null` included, replaces. */
function merge(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value);
  return out;
}

export function parseConfig(text: string, profileName: string, overrides: Record<string, unknown> = {}): Config {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw) || !isObject(raw.defaults) || !isObject(raw.profiles)) throw new Error("test-health config needs `defaults` and `profiles`");
  const profile = raw.profiles[profileName];
  if (!isObject(profile)) throw new Error(`Unknown test-health profile: ${profileName} (known: ${Object.keys(raw.profiles).join(", ")})`);
  if (typeof raw.ledgerRemote !== "string" || typeof raw.ledgerRef !== "string") throw new Error("test-health config needs `ledgerRemote` and `ledgerRef`");
  const resolved = merge(merge(raw.defaults, profile), overrides) as Omit<Profile, "name">;
  for (const key of ["clusterSize", "sweepEvery", "claimHours", "reauditDays", "wipMaxBytes", "proofOverrunMinutes"] as const) {
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0) throw new Error(`test-health config: ${key} must be a positive number`);
  }
  if (typeof resolved.base !== "string" || !resolved.base) throw new Error("test-health config: base must name a ref");
  if (resolved.smallPackageFiles !== null && !(Number.isInteger(resolved.smallPackageFiles) && resolved.smallPackageFiles >= 0)) {
    throw new Error("test-health config: smallPackageFiles must be a whole number or null");
  }
  return { ledgerRemote: raw.ledgerRemote, ledgerRef: raw.ledgerRef, profile: { ...resolved, name: profileName } };
}

export function loadConfig(profileName = "cron", overrides: Record<string, unknown> = {}, file = CONFIG_FILE): Config {
  return parseConfig(readFileSync(file, "utf8"), profileName, overrides);
}
