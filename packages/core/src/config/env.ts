/**
 * Environment chokepoint — the ONLY file in this package allowed to touch
 * `process.env` (enforced by `scripts/check-env-access.ts`).
 *
 * Two exports matter to the rest of the package:
 * - `resolveEnv()` reads every statically-named variable at CALL time and
 *   returns a plain config object. Call it where the value is needed; never
 *   capture the result at module scope — a key absent at import time may be
 *   present at call time, and the lint bans module-scope env constants.
 * - `readEnvVar()` covers the config-named reads (a `brain.config` provider
 *   block can point at any variable via `apiKeyEnv`), which no static list
 *   can enumerate. `DYNAMIC_ENV_READS` documents those families.
 *
 * `ENV_VARS` is the runtime-introspectable contract: the env parity gate
 * diffs it against the package's env documentation in both directions.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { envFlag, envPresent } from "./env-core.js";

// The descriptor contract, readEnvVar and the boolean helpers are shared
// across every chokepoint via the sync-enforced copy in ./env-core.ts.
export type { DynamicEnvReadSpec } from "./env-core.js";
export { readEnvVar } from "./env-core.js";

import type { DynamicEnvReadSpec } from "./env-core.js";

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
    name: "BRAIN_ROOT",
    description: "Brain repository root, overriding cwd-based discovery.",
    default: "nearest ancestor with brain.config.* or .git, else cwd",
    required: false,
  },
  {
    name: "BRAIN_RERANK_MODE",
    description:
      'Search reranker mode: "jev", "heuristic" or "none". Overrides the ' +
      "configured `reranker.provider`; an explicit --rerank still wins. " +
      "Cannot enable model reranking: reranker.enabled must be true.",
    default: "the configured provider when enabled and available, else heuristic",
    required: false,
  },
  {
    name: "XDG_BIN_HOME",
    description: "Directory the `brain` CLI symlink is installed into.",
    default: "~/.local/bin",
    required: false,
  },
  {
    name: "NO_COLOR",
    description: "Any non-empty value suppresses ANSI color in CLI output.",
    required: false,
  },
  {
    name: "BRAIN_CHROME_NO_SANDBOX",
    description:
      '"1" launches the render Chrome without its sandbox (required when running as root).',
    default: "sandbox on",
    required: false,
  },
  {
    name: "BRAIN_UI_CHROME_NO_SANDBOX",
    description:
      "Same as BRAIN_CHROME_NO_SANDBOX, in the BRAIN_UI_* spelling a chat-server deployment sets; the server passes it to the brain CLI it spawns.",
    default: "sandbox on",
    required: false,
  },
  {
    name: "CLAUDE_CODE_PATH",
    description:
      "Claude Code binary the Claude agent runner spawns, as for the chat server.",
    default: "the Agent SDK's built-in binary when the SDK is installed, else `claude` on PATH",
    required: false,
  },
  {
    name: "GEMINI_API_KEY",
    description:
      "Default API key for the built-in Gemini embedding/completion providers " +
      "(default name only — a config `apiKeyEnv` can point elsewhere). Absent " +
      "key degrades vector search to FTS.",
    required: false,
  },
  {
    name: "TYPESAFE_API_KEY",
    description:
      "Default TypeSafe AI key for Jev: the built-in jev search reranker (default " +
      "name only — a config `apiKeyEnv` can point elsewhere) and the judgments " +
      "`brain sync` asks. Search also requires reranker.enabled: true. " +
      "Absent key keeps the lifecycle (heuristic) search " +
      "ordering, and every sync judgment takes its conservative default.",
    required: false,
  },
  {
    name: "ANTHROPIC_API_KEY",
    description:
      "Default API key for the built-in Anthropic completion provider " +
      "(default name only — a config `apiKeyEnv` can point elsewhere).",
    required: false,
  },
];

export const DYNAMIC_ENV_READS: readonly DynamicEnvReadSpec[] = [
  {
    source: "brain.config `embeddings.apiKeyEnv` / `completions.apiKeyEnv` / `completions.fallbackApiKeyEnv` / `reranker.apiKeyEnv`",
    description:
      "API key for a built-in provider or completion fallback, read at call time under whatever " +
      "name the config declares (defaults: GEMINI_API_KEY, ANTHROPIC_API_KEY, " +
      "TYPESAFE_API_KEY).",
  },
  {
    source: "call-time inherited environment snapshot (`inheritedEnv`)",
    description:
      "Internal agent-CLI transport: copies the calling process's environment " +
      "at spawn time and merges explicit overrides last. Unlike the UI's " +
      "filtered subprocess environment, this snapshot is inherited in full; " +
      "it does not make every inherited variable supported brain configuration.",
  },
];

/** Statically-named environment configuration, resolved at call time. */
export interface CoreEnv {
  /** BRAIN_ROOT, or undefined to fall back to cwd-based discovery. */
  brainRoot: string | undefined;
  /** BRAIN_RERANK_MODE, unvalidated (the reranker validates it). */
  rerankMode: string | undefined;
  /** XDG_BIN_HOME with the ~/.local/bin fallback applied. */
  binDir: string;
  /** NO_COLOR is set (to anything non-empty). */
  noColor: boolean;
  /** Either no-sandbox spelling is truthy (1/true/on/yes). */
  chromeNoSandbox: boolean;
  /** CLAUDE_CODE_PATH, or undefined to run the Agent SDK's built-in binary. */
  claudeCodePath: string | undefined;
  /** TYPESAFE_API_KEY, trimmed, or undefined when unset or blank (the sync judge is then off). */
  typesafeApiKey: string | undefined;
}

/**
 * The environment a spawned agent CLI inherits — this process's own, read at
 * call time — with `overrides` set over it. Passed explicitly because a spawn
 * without an `env` does not see changes made to `process.env` after start-up.
 */
export function inheritedEnv(
  overrides: Readonly<Record<string, string>>
): Record<string, string | undefined> {
  return { ...process.env, ...overrides };
}

/** Resolve the statically-named variables. Reads happen here and only here. */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): CoreEnv {
  return {
    brainRoot: env.BRAIN_ROOT || undefined,
    rerankMode: env.BRAIN_RERANK_MODE,
    binDir: env.XDG_BIN_HOME || join(homedir(), ".local", "bin"),
    noColor: envPresent(env.NO_COLOR),
    chromeNoSandbox:
      envFlag(env.BRAIN_CHROME_NO_SANDBOX, false) ||
      envFlag(env.BRAIN_UI_CHROME_NO_SANDBOX, false),
    claudeCodePath: env.CLAUDE_CODE_PATH || undefined,
    typesafeApiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
  };
}
