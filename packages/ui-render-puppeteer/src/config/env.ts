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
    name: "PUPPETEER_EXECUTABLE_PATH",
    description: "Chrome/Chromium executable to launch (checked first).",
    default: "well-known system install paths",
    required: false,
  },
  {
    name: "BRAIN_UI_CHROME_PATH",
    description:
      "Chrome/Chromium executable to launch (brain-ui's spelling; checked " +
      "after PUPPETEER_EXECUTABLE_PATH).",
    default: "well-known system install paths",
    required: false,
  },
];

/** Statically-named environment configuration, resolved at call time. */
export interface RendererEnv {
  /** PUPPETEER_EXECUTABLE_PATH, when set. */
  puppeteerExecutablePath: string | undefined;
  /** BRAIN_UI_CHROME_PATH, when set. */
  chromePath: string | undefined;
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): RendererEnv {
  return {
    puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH,
    chromePath: env.BRAIN_UI_CHROME_PATH,
  };
}
