/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * `resolveEnv()` reads at CALL time and returns a plain config object; never
 * capture the result at module scope. `ENV_VARS` is the runtime-introspectable
 * contract the env parity gate diffs against the package's env documentation.
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

export const ENV_VARS: readonly EnvVarSpec[] = [
  {
    name: "CHROME_CDP_URL",
    description:
      "DevTools endpoint of the Chrome instance used to scrape browser-only " +
      "job boards. Unreachable/absent Chrome skips the browser phase.",
    default: "http://127.0.0.1:9222",
    required: false,
  },
];

/** Statically-named environment configuration, resolved at call time. */
export interface JobsEnv {
  /** CHROME_CDP_URL with the local-Chrome default applied. */
  cdpUrl: string;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): JobsEnv {
  return {
    cdpUrl: env.CHROME_CDP_URL || "http://127.0.0.1:9222",
  };
}
