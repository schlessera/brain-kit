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

import { envFlag } from "@schlessera/brain-common/internal/env";
import type { DynamicEnvReadSpec } from "@schlessera/brain-common/internal/env";
import { type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import {
  EXEC_KILLER_ENV,
  EXEC_WRAPPER_ENV,
  validateExecWrapper,
} from "@schlessera/brain-ui-sdk/internal";
import { filterSubprocessEnv, parseSubprocessEnvExtra } from "@schlessera/brain-ui-sdk/internal";

// The descriptor contract, readEnvVar and the boolean helpers are shared
// across every chokepoint via @schlessera/brain-common/internal/env.
export type { DynamicEnvReadSpec } from "@schlessera/brain-common/internal/env";
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
    name: EXEC_WRAPPER_ENV,
    description:
      "Absolute path to an executable the Claude Code subprocess is launched " +
      "through, as `<wrapper> <program> <args…>`. Lets a host run the agent " +
      "as another user without this package knowing how. It is an argv[0], " +
      "never a command line: no shell parses it. Unset, the SDK spawns exactly " +
      "as it did before.",
    default: "(none — let the SDK spawn directly)",
    required: false,
  },
  {
    name: EXEC_KILLER_ENV,
    description:
      "Absolute path to an authorised helper that cancels the wrapped Claude " +
      "Code process group, invoked as `<killer> <pgid> <TERM|KILL|INT>`. " +
      "Needed only when the wrapper changes uid: signalling then fails with " +
      "EPERM however the group is arranged, and an aborted turn would keep " +
      "running.",
    default: "(none — signal the group directly)",
    required: false,
  },
  {
    name: "BRAIN_UI_SUBPROCESS_ENV_EXTRA",
    description:
      "Comma-separated environment variable names to admit to the Claude " +
      "Code subprocess when an operator integration needs a variable outside " +
      "the shipped agent allowlist. Names are trimmed; malformed entries are " +
      "ignored; the control variable itself is never forwarded.",
    default: "(empty)",
    required: false,
  },
  {
    name: "ANTHROPIC_API_KEY",
    description:
      "API key for the Anthropic Models API (model discovery), used when no " +
      "subscription token is set. Never reaches a chat turn on a profile " +
      "without its own credential: those run on the subscription.",
    required: false,
  },
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    description:
      "Subscription token: authenticates chat turns on every profile without " +
      "its own credential, and model discovery. Wins over ANTHROPIC_API_KEY.",
    required: false,
  },
  {
    name: "ANTHROPIC_BASE_URL",
    description:
      "Anthropic-compatible endpoint inherited by profiles that declare no " +
      "baseUrl of their own. Read to classify a run's pricing route; also " +
      "passed through to the agent subprocess.",
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
    name: "NOMINATIM_PUBLIC_SERVICE_ELIGIBLE",
    description: "Explicit informed public Nominatim eligibility; enabled alone does not qualify. Configure a suitable endpoint for excluded uses.",
    default: "false",
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
      "The Claude Code subprocess receives the SDK agent allowlist, the " +
      "selected profile's declared credential names, and operator extras " +
      "(with profile overrides merged on top).",
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
  /** NOMINATIM_PUBLIC_SERVICE_ELIGIBLE explicitly records informed eligibility. */
  nominatimPublicServiceEligible: boolean;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): ClaudeBackendEnv {
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    reverseGeocodeEnabled: envFlag(env.BRAIN_UI_REVERSE_GEOCODE, true),
    nominatimUrl: env.NOMINATIM_URL || "https://nominatim.openstreetmap.org",
    nominatimUserAgent: env.NOMINATIM_USER_AGENT || "brain-kit-ui/1.0",
    nominatimPublicServiceEligible: envFlag(env.NOMINATIM_PUBLIC_SERVICE_ELIGIBLE, false),
  };
}

/**
 * The filtered host environment for the Claude Code subprocess (profile env
 * overrides are merged on top by the caller). Documented in
 * `DYNAMIC_ENV_READS`; keep this the only whole-environment read.
 */
export function envSnapshot(extraNames: readonly string[] = []): NodeJS.ProcessEnv {
  const operatorNames = parseSubprocessEnvExtra(
    process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA
  );
  return filterSubprocessEnv(process.env, "agent", [
    ...operatorNames,
    ...extraNames,
  ]);
}

/**
 * The exec wrapper, or undefined. Read at turn start rather than cached: the
 * process may gain the variable after this module loads, and a stale read of a
 * privilege boundary is the wrong kind of stale.
 */
export function resolveExecConfig(env: NodeJS.ProcessEnv = process.env): ExecWrapperConfig {
  return {
    wrapper: validateExecWrapper(env[EXEC_WRAPPER_ENV]),
    killer: validateExecWrapper(env[EXEC_KILLER_ENV]),
  };
}
