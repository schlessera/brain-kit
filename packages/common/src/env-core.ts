/**
 * Shared core of every package's environment chokepoint.
 *
 * Internal to brain-kit: reached through `@schlessera/brain-common/internal/env`,
 * with no compatibility promise (docs/decisions/public-export-boundary.md).
 * Each package with an env chokepoint (`src/config/env.ts`) imports it from
 * there; it replaced the byte-identical per-package copies a sync test held
 * (#1396). `scripts/env-docs.ts` imports this file directly.
 *
 * What belongs here: the descriptor contract the env-docs generator and the
 * env-parity gate consume, the dynamic-read escape hatch, and the boolean
 * parsing helpers. What does NOT belong here: `resolveEnv` — each package's
 * resolver reads its own variables into its own shape and stays in that
 * package's `env.ts`.
 */

/** One environment variable a package reads. */
export interface EnvVarSpec {
  /** Variable name as it appears in the environment. */
  name: string;
  /** What it controls. */
  description: string;
  /**
   * Behaviour when the variable is unset. Omitted or null when there is no
   * meaningful default to state.
   */
  default?: string | null;
  /**
   * `true` when the package cannot do its job at all without it, `false`
   * when optional; a string states the CONDITION under which it becomes
   * required (e.g. "AUTH_MODE=password") — flattening that to a boolean
   * would lose the only part a reader needs.
   */
  required: boolean | string;
}

/** A family of reads whose variable NAME is data, not code. */
export interface DynamicEnvReadSpec {
  /** Where the variable name comes from. */
  source: string;
  /** What the value is used for. */
  description: string;
}

/**
 * Call-time read of a single variable whose name is data (see the package's
 * `DYNAMIC_ENV_READS`) or whose presence gates a feature. Never cache the
 * result at module scope.
 */
export function readEnvVar(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env[name];
}

const TRUTHY_TOKENS: readonly string[] = ["1", "true", "on", "yes"];
const FALSY_TOKENS: readonly string[] = ["0", "false", "off", "no"];

/**
 * The one way a token-valued boolean environment variable is parsed.
 *
 * Truthy: 1 / true / on / yes. Falsy: 0 / false / off / no. Matching is
 * case-insensitive after trimming. Unset, empty, or any unrecognised token
 * returns `defaultValue` — a typo in a flag must never silently flip a
 * behaviour; it falls back to the documented default instead.
 */
export function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const token = value.trim().toLowerCase();
  if (TRUTHY_TOKENS.includes(token)) return true;
  if (FALSY_TOKENS.includes(token)) return false;
  return defaultValue;
}

/**
 * Presence-based boolean: set to ANY non-empty value means on. This is the
 * `NO_COLOR` convention (https://no-color.org) — `NO_COLOR=0` still disables
 * color — so it must NOT go through `envFlag`. Use only for variables whose
 * documented contract is presence, not a token.
 */
export function envPresent(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
