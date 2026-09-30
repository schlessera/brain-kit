/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * `resolveEnv()` reads at CALL time and returns a plain config object; never
 * capture the result at module scope. `ENV_VARS` is the runtime-introspectable
 * contract the env parity gate diffs against this package's README.
 */

import { envFlag } from "./env-core.js";

// The descriptor contract and the boolean helpers are shared across every
// chokepoint via the sync-enforced copy in ./env-core.ts.

/**
 * The default User-Agent, and the reason it is not a browser string.
 *
 * A published package that impersonates Chrome by default makes every consumer
 * misrepresent themselves without choosing to, and it defeats the site
 * operator's ability to rate-limit or block this traffic specifically — which
 * is the mechanism that keeps scraping tolerable. Sites that filter on
 * User-Agent will refuse this; that is a per-site configuration decision
 * (`userAgent` on the fetch options), taken deliberately, not a default.
 *
 * The version is not interpolated: it would have to be read at module scope
 * from a package.json import, and it is not worth a build-time dependency for
 * a string a site operator reads once.
 */
export const DEFAULT_USER_AGENT =
  "brain-scrape (+https://github.com/schlessera/brain-kit)";

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
    name: "SCRAPE_USER_AGENT",
    description:
      "User-Agent sent with every request, and the token matched against " +
      "robots.txt groups. Override per site via fetch options rather than " +
      "globally where possible.",
    default: DEFAULT_USER_AGENT,
    required: false,
  },
  {
    name: "SCRAPE_CHROME_URL",
    description:
      "DevTools endpoint of an ALREADY RUNNING Chrome to drive instead of " +
      "launching one (e.g. http://127.0.0.1:9222). Unset means this package " +
      "launches and owns its own browser.",
    required: false,
  },
  {
    name: "SCRAPE_CHROME_PATH",
    description:
      "Chrome/Chromium executable to launch for browser-rendered sites. " +
      "Unset falls back to the usual distro paths.",
    required: false,
  },
  {
    name: "SCRAPE_CHROME_NO_SANDBOX",
    description:
      "Set to 1 to launch Chrome with --no-sandbox. Required only when the " +
      "process runs as root (a container). Weaker: a renderer exploit then " +
      "lands on the host user.",
    default: "unset (sandbox stays on)",
    required: false,
  },
  {
    name: "SCRAPE_RESPECT_ROBOTS",
    description:
      "Set to 0/off/false to stop enforcing robots.txt in every HTTP client built " +
      "from resolveEnv() (a ScrapeClient constructed directly follows its own " +
      "respectRobots option). Browser navigation is unaffected. The per-site opt-out is preferred; this exists " +
      "for a run against a host you operate.",
    default: "on",
    required: false,
  },
];

/** Statically-named environment configuration, resolved at call time. */
export interface ScrapeEnv {
  userAgent: string;
  /** DevTools endpoint to attach to; undefined means launch a browser. */
  chromeUrl?: string;
  /** Explicit Chrome executable; undefined means probe the usual paths. */
  chromePath?: string;
  noSandbox: boolean;
  respectRobots: boolean;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): ScrapeEnv {
  return {
    userAgent: env.SCRAPE_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    chromeUrl: env.SCRAPE_CHROME_URL?.trim() || undefined,
    chromePath: env.SCRAPE_CHROME_PATH?.trim() || undefined,
    noSandbox: envFlag(env.SCRAPE_CHROME_NO_SANDBOX, false),
    respectRobots: envFlag(env.SCRAPE_RESPECT_ROBOTS, true),
  };
}
