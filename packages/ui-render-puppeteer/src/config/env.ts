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
