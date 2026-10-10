/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * `resolveEnv()` reads at CALL time and returns a plain config object; never
 * capture the result at module scope — the same brain runs on a laptop with
 * several keys and in a container with none, and availability is resolved
 * when asked, not at import. `readEnvVar()` covers the provider-declared
 * key lookups (`Provider.apiKeyEnv` is data on the provider record).
 *
 * `ENV_VARS` is the runtime-introspectable contract the env parity gate
 * diffs against the package's env documentation.
 */

// The descriptor contract and readEnvVar are shared across every chokepoint
// via @schlessera/brain-common/internal/env.
export { readEnvVar } from "@schlessera/brain-common/internal/env";

/**
 * One environment variable this package reads.
 *
 * Deliberately LOCAL and narrower than the shared EnvVarSpec: this is the
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
    name: "OPENAI_API_KEY",
    description:
      "API key for the OpenAI image models (the openai provider's declared apiKeyEnv). " +
      "Absent key hides that provider's models.",
    required: false,
  },
  {
    name: "GEMINI_API_KEY",
    description:
      "API key for Google's image models (the gemini provider's declared apiKeyEnv). " +
      "Absent key hides that provider's models.",
    required: false,
  },
  {
    name: "OPENAI_BASE_URL",
    description: "Override for the OpenAI REST endpoint.",
    default: "https://api.openai.com/v1",
    required: false,
  },
  {
    name: "GEMINI_BASE_URL",
    description: "Override for the Gemini Interactions API endpoint.",
    default: "https://generativelanguage.googleapis.com/v1beta",
    required: false,
  },
];

/** Statically-named environment configuration, resolved at call time. */
export interface ImagesEnv {
  /** OPENAI_BASE_URL with the public default applied. */
  openaiBaseUrl: string;
  /** GEMINI_BASE_URL with the public default applied. */
  geminiBaseUrl: string;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): ImagesEnv {
  return {
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    geminiBaseUrl:
      env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta",
  };
}
