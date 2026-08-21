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

// The descriptor contract and readEnvVar are shared across every chokepoint
// via the sync-enforced copy in ./env-core.ts.
import type { DynamicEnvReadSpec } from "./env-core.js";
export type { DynamicEnvReadSpec } from "./env-core.js";
export { readEnvVar } from "./env-core.js";

/**
 * One environment variable this package reads.
 *
 * Deliberately LOCAL and narrower than env-core's EnvVarSpec: this is the
 * package's published descriptor shape, and widening it to the shared
 * union would be a breaking change for typed consumers of ENV_VARS.
 */
export interface EnvVarSpec {
  /** Variable name as it appears in the environment. */
  name: string;
  /** What it controls. */
  description: string;
  /** Behaviour when the variable is unset, when there is a default. */
  default?: string;
  required: boolean;
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
