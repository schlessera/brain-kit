/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * `resolveEnv()` reads every statically-named variable at CALL time and
 * returns a plain config object; never capture the result at module scope —
 * credentials may appear after import, and profile availability is checked
 * when asked. `readEnvVar()` covers the profile-declared reads (a profile's
 * `authTokenEnv` / `apiKeyEnv` can name any variable), and `envSnapshot()`
 * is the filtered environment handed to the Claude Code subprocess.
 * `DYNAMIC_ENV_READS` documents both families.
 *
 * `ENV_VARS` is the runtime-introspectable contract the env parity gate
 * diffs against the package's env documentation.
 */

import { envFlag } from "./env-core.js";
import type { DynamicEnvReadSpec } from "./env-core.js";
import { filterSubprocessEnv } from "@schlessera/brain-ui-sdk/server";

// The descriptor contract, readEnvVar and the boolean helpers are shared
// across every chokepoint via the sync-enforced copy in ./env-core.ts.
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
    name: "ANTHROPIC_API_KEY",
    description:
      "API key for the Anthropic Models API (model discovery). Takes " +
      "precedence over the subscription token, mirroring the Agent SDK.",
    required: false,
  },
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    description:
      "Subscription token for the Anthropic Models API (model discovery), " +
      "used when no API key is set.",
    required: false,
  },
  {
    name: "BRAIN_UI_REVERSE_GEOCODE",
    description:
      '"0"/"off"/"false" disables reverse geocoding in the location tool ' +
      "(raw coordinates only).",
    default: "enabled",
    required: false,
  },
  {
    name: "NOMINATIM_URL",
    description: "Reverse-geocoding endpoint.",
    default: "https://nominatim.openstreetmap.org",
    required: false,
  },
  {
    name: "NOMINATIM_USER_AGENT",
    description: "Identifying User-Agent for Nominatim (usage-policy requirement).",
    default: "brain-kit-ui/1.0",
    required: false,
  },
];

export const DYNAMIC_ENV_READS: readonly DynamicEnvReadSpec[] = [
  {
    source: "inference profile `authTokenEnv` / `apiKeyEnv`",
    description:
      "Credential for a declared inference profile, read at query time under " +
      "whatever name the profile declares (also drives profile availability).",
  },
  {
    source: "filtered environment snapshot",
    description:
      "The Claude Code subprocess inherits the host environment minus " +
      "server-only variables (with profile overrides merged on top).",
  },
];

/** Statically-named environment configuration, resolved at call time. */
export interface ClaudeBackendEnv {
  /** ANTHROPIC_API_KEY, untrimmed. */
  anthropicApiKey: string | undefined;
  /** CLAUDE_CODE_OAUTH_TOKEN, untrimmed. */
  claudeCodeOauthToken: string | undefined;
  /** BRAIN_UI_REVERSE_GEOCODE is not falsy (0/false/off/no, case-insensitive). */
  reverseGeocodeEnabled: boolean;
  /** NOMINATIM_URL with the public-OSM default applied. */
  nominatimUrl: string;
  /** NOMINATIM_USER_AGENT with the default applied. */
  nominatimUserAgent: string;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): ClaudeBackendEnv {
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    reverseGeocodeEnabled: envFlag(env.BRAIN_UI_REVERSE_GEOCODE, true),
    nominatimUrl: env.NOMINATIM_URL || "https://nominatim.openstreetmap.org",
    nominatimUserAgent: env.NOMINATIM_USER_AGENT || "brain-kit-ui/1.0",
  };
}

/**
 * The filtered host environment for the Claude Code subprocess (profile env
 * overrides are merged on top by the caller). Documented in
 * `DYNAMIC_ENV_READS`; keep this the only whole-environment read.
 */
export function envSnapshot(): NodeJS.ProcessEnv {
  return filterSubprocessEnv(process.env);
}
