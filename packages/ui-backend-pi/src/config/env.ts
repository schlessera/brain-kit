/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * This package's sole read is data-driven: the brain config names the
 * variable holding the embedding provider's API key (`embeddings.apiKeyEnv`,
 * default GEMINI_API_KEY), so it goes through `readEnvVar()` at call time —
 * never cache the result at module scope. `ENV_VARS` lists the default name;
 * `DYNAMIC_ENV_READS` documents the family. Both are the runtime-
 * introspectable contract the env parity gate diffs against the package's
 * env documentation.
 */

/** One environment variable this package reads. */
export interface EnvVarSpec {
  /** Variable name as it appears in the environment. */
  name: string;
  /** What it controls. */
  description: string;
  /** Behaviour when the variable is unset, when there is a default. */
  default?: string;
  /** True when the package cannot do its job at all without it. */
  required: boolean;
}

/** A family of reads whose variable NAME is data, not code. */
export interface DynamicEnvReadSpec {
  /** Where the variable name comes from. */
  source: string;
  /** What the value is used for. */
  description: string;
}

export const ENV_VARS: readonly EnvVarSpec[] = [
  {
    name: "GEMINI_API_KEY",
    description:
      "Default API key gating the brain's embedding provider (default name " +
      "only — a config `apiKeyEnv` can point elsewhere). Absent key degrades " +
      "search to FTS-only.",
    required: false,
  },
];

export const DYNAMIC_ENV_READS: readonly DynamicEnvReadSpec[] = [
  {
    source: "brain.config `embeddings.apiKeyEnv`",
    description:
      "API key presence check for the configured embedding provider, read at " +
      "call time under whatever name the config declares (default: GEMINI_API_KEY).",
  },
];

/**
 * Call-time read of a single variable whose name is data (see
 * `DYNAMIC_ENV_READS`). Never cache the result at module scope.
 */
export function readEnvVar(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return env[name];
}
