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

import { existsSync, readFileSync } from "fs";

// The descriptor contract and readEnvVar are shared across every chokepoint
// via the sync-enforced copy in ./env-core.ts.
import type { DynamicEnvReadSpec } from "./env-core.js";
import { envFlag } from "./env-core.js";
export type { DynamicEnvReadSpec } from "./env-core.js";
export { readEnvVar } from "./env-core.js";
import { type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import {
  EXEC_KILLER_ENV,
  EXEC_WRAPPER_ENV,
  readWebSearchOverride,
  readWebSearchRouting,
  resolveWebSearchConfigPath,
  validateExecWrapper,
  webSearchProvider,
  WEB_SEARCH_PROVIDERS,
} from "@schlessera/brain-ui-sdk/internal";
import { filterSubprocessEnv, parseSubprocessEnvExtra } from "@schlessera/brain-ui-sdk/internal";

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
    name: EXEC_WRAPPER_ENV,
    description:
      "Absolute path to an executable every tool subprocess is launched " +
      "through, as `<wrapper> <program> <args…>`. Lets a host run the agent's " +
      "children as another user without this package knowing how. It is an " +
      "argv[0], never a command line: no shell parses it. Unset, spawns are " +
      "exactly what they were.",
    default: "(none — spawn the program directly)",
    required: false,
  },
  {
    name: EXEC_KILLER_ENV,
    description:
      "Absolute path to an authorised helper that cancels a wrapped process " +
      "group, invoked as `<killer> <pgid> <TERM|KILL|INT>`. Needed only when " +
      "the wrapper changes uid: signalling then fails with EPERM however the " +
      "group is arranged, and an aborted turn would keep running.",
    default: "(none — signal the group directly)",
    required: false,
  },
  {
    name: "BRAIN_UI_SUBPROCESS_ENV_EXTRA",
    description:
      "Comma-separated environment variable names to admit to pi tool " +
      "subprocesses when an operator integration needs a variable outside " +
      "the shipped agent allowlist. Names are trimmed; malformed entries are " +
      "ignored; the control variable itself is never forwarded.",
    default: "(empty)",
    required: false,
  },
  {
    name: "GEMINI_API_KEY",
    description:
      "Default API key gating the brain's embedding provider (default name " +
      "only — a config `apiKeyEnv` can point elsewhere). Absent key degrades " +
      "search to FTS-only.",
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

/** Statically-named environment configuration, resolved at call time. */
export interface PiBackendEnv {
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
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): PiBackendEnv {
  return {
    reverseGeocodeEnabled: envFlag(env.BRAIN_UI_REVERSE_GEOCODE, true),
    nominatimUrl: env.NOMINATIM_URL || "https://nominatim.openstreetmap.org",
    nominatimUserAgent: env.NOMINATIM_USER_AGENT || "brain-kit-ui/1.0",
    nominatimPublicServiceEligible: envFlag(env.NOMINATIM_PUBLIC_SERVICE_ELIGIBLE, false),
  };
}

/**
 * The exec wrapper and its cancellation helper. Resolved per spawn rather than
 * cached at module scope, matching this file's rule for everything else: the
 * process may gain the variables after this module loads, and a stale read of
 * a privilege boundary is the wrong kind of stale.
 */
export function resolveExecConfig(env: NodeJS.ProcessEnv = process.env): ExecWrapperConfig {
  return {
    wrapper: validateExecWrapper(env[EXEC_WRAPPER_ENV]),
    killer: validateExecWrapper(env[EXEC_KILLER_ENV]),
  };
}

export const DYNAMIC_ENV_READS: readonly DynamicEnvReadSpec[] = [
  {
    source: "web-search provider catalog (`WEB_SEARCH_PROVIDERS`)",
    description:
      "Presence check for each web-search provider's API key (EXA_API_KEY, " +
      "PERPLEXITY_API_KEY, BRAVE_API_KEY, …), so a provider configured by " +
      "environment rather than by `web-search.json` is not reported as " +
      "unusable. Values are never read out.",
  },
  {
    source: "brain.config `embeddings.apiKeyEnv`",
    description:
      "API key presence check for the configured embedding provider, read at " +
      "call time under whatever name the config declares (default: GEMINI_API_KEY).",
  },
  {
    source: "filtered environment snapshot (`subprocessEnv`)",
    description:
      "At each tool spawn, forwards the SDK agent allowlist plus valid operator " +
      "names from BRAIN_UI_SUBPROCESS_ENV_EXTRA and explicitly admitted per-spawn " +
      "names. The control variable itself is never forwarded. This is internal " +
      "transport, not unrestricted inheritance or additional supported configuration.",
  },
];

/**
 * The environment the web-search surface reads: the variables that locate the
 * extension's `web-search.json`, plus each provider's API-key variable.
 *
 * PRESENCE is all anything does with the key values — they are never logged,
 * returned over the API, or copied into the config file. Reading them here
 * keeps the rest of the package taking configuration as a value.
 */
export function resolveWebSearchEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const names = [
    "PI_CODING_AGENT_DIR",
    "XDG_CONFIG_HOME",
    "HOME",
    ...WEB_SEARCH_PROVIDERS.map((p) => p.envVar).filter((n): n is string => Boolean(n)),
  ];
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}

/**
 * Environment names for the providers selected by the active web-search
 * config. A malformed or absent file has no explicit enabled set.
 */
export function resolveEnabledWebSearchEnvNames(): string[] {
  try {
    const env = resolveWebSearchEnv();
    const path = resolveWebSearchConfigPath(env);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const config = parsed as Record<string, unknown>;
    const override = readWebSearchOverride(config);
    const ids = override
      ? override.split(",").map((id) => id.trim())
      : readWebSearchRouting(config);
    return [
      ...new Set(
        ids
          .map((id) => webSearchProvider(id)?.envVar)
          .filter((name): name is string => Boolean(name))
      ),
    ];
  } catch {
    return [];
  }
}

/** Allowlisted ambient environment handed to each pi tool subprocess. */
export function subprocessEnv(
  extraNames: readonly string[] = []
): NodeJS.ProcessEnv {
  const operatorNames = parseSubprocessEnvExtra(
    process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA
  );
  return filterSubprocessEnv(process.env, "agent", [
    ...operatorNames,
    ...extraNames,
  ]);
}
