/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * `resolveEnv()` reads at CALL time and returns a plain config object; never
 * capture the result at module scope. `ENV_VARS` is the runtime-introspectable
 * contract the env parity gate diffs against the package's env documentation.
 */

// The descriptor contract is shared across every chokepoint via the
// sync-enforced copy in ./env-core.ts.

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
    name: "CHROME_CDP_URL",
    description:
      "Legacy alias for SCRAPE_CHROME_URL: the DevTools endpoint of an " +
      "already-running Chrome used for browser-only boards. Kept so an " +
      "existing deployment keeps working; SCRAPE_CHROME_URL wins when both " +
      "are set. Unreachable or absent Chrome downgrades the browser boards " +
      "and leaves the rest of the scrape alone.",
    required: false,
  },
];

/**
 * Statically-named environment configuration, resolved at call time.
 *
 * Everything else this module needs to scrape politely — User-Agent,
 * robots.txt enforcement, the Chrome executable — is read by
 * `@schlessera/brain-scrape`'s own chokepoint under `SCRAPE_*`. This file
 * exists only for the one variable that predates that package.
 */
export interface JobsEnv {
  /** CHROME_CDP_URL, or undefined when unset. */
  cdpUrl?: string;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): JobsEnv {
  return {
    cdpUrl: env.CHROME_CDP_URL?.trim() || undefined,
  };
}
