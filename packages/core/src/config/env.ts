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

import { envFlag, envPresent } from "@schlessera/brain-common/internal/env";

// The descriptor contract, readEnvVar and the boolean helpers are shared
// across every chokepoint via @schlessera/brain-common/internal/env.
export type { DynamicEnvReadSpec } from "@schlessera/brain-common/internal/env";
export { readEnvVar } from "@schlessera/brain-common/internal/env";

import type { DynamicEnvReadSpec } from "@schlessera/brain-common/internal/env";

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
  { name: "BRAIN_STORAGE_GIT_ROOTS", description: "Trusted storage inventory allowlist: JSON array of up to 16 absolute external Git store roots. Request flags cannot expand it.", default: "no external Git stores", required: false },
  { name: "BRAIN_WORKER_DATA_ROOT", description: "Internal data root for maintenance and hosted turn workers, supplied by the trusted worker launch together with BRAIN_WORKER_CONFIG_ROOT; not an operator input.", required: false },
  { name: "BRAIN_WITHHELD_KEYS", description: "Internal: comma-separated names (never values) of the provider keys the server withheld from this governed or strict agent worker. A command that needs one names the provider with a `provider_unavailable` notice and degrades where it can; set by the worker launcher, not an operator input.", default: "no key is withheld; a missing key keeps the ordinary keyless behaviour", required: false },
  { name: "BRAIN_PROVIDER_RELAY_SOCKET", description: "Internal: absolute path of the server's provider relay socket in a governed or strict agent worker or a relayed maintenance worker. A built-in Gemini, Anthropic or OpenAI image provider whose key the server withheld sends its native request there, and the server adds the key, meters the request and refuses it once a budget is blocked; set by the worker launcher, not an operator input.", default: "no relay; a provider uses its key from the environment", required: false },
  { name: "BRAIN_AGENT_RUNNER_UNAVAILABLE", description: "Internal: set to `1` by the worker launcher in a credential-free maintenance worker, such as the one hosted `brain sync` runs in, where no agent can log in. The configured agent runner is then treated as absent: bare `brain sync` hands nothing to an agent and reports that judgment is unavailable, so a conflict it leaves is resolved by hand; set by the worker launcher, not an operator input.", default: "the configured agent runner is used", required: false },
  { name: "BRAIN_MEDIA_PINNED_PATH_LIMIT", description: "Trusted host bound on the distinct conversation-pinned scratch paths one media inventory reads (`brain hygiene`, review and `brain sync`'s media count). A positive integer; past it the inventory reports that conversation links were not fully checked, and never claims an exhaustive scan. Anything else stops media detection rather than being guessed.", default: "5000", required: false },
  { name: "BRAIN_MEDIA_REFERENCE_LIMITS", description: "Trusted host bounds on the declared reference scan behind every media finding (`brain hygiene`, review and `brain sync`'s media count): comma-separated `<limit>=<positive integer>` pairs over `notes` (50000), `noteBytes` (268435456), `perNote` (4194304), `scanTime` in milliseconds (20000), `refsPerFinding` (500), and for a media effect's plan `rewrittenNotes` (200) and `preview` in bytes (1048576), with `perNote` at most `noteBytes`. Past a limit the scan or plan is refused and nothing claims the references were checked. Anything else stops media detection rather than being guessed.", default: "the Q1 defaults", required: false },
  { name: "BRAIN_WORKER_OUTPUT_ALLOWANCE", description: "Internal: JSON `{\"bytes\":N,\"setting\":\"NAME\"}` naming the size of a maintenance worker's private writable output stage and the host setting that controls it. When `brain maintain`'s git packing runs out of space, its `git` step names that allowance and setting; set by the worker launcher, not an operator input.", default: "the step reports the space shortfall without a setting", required: false },
  { name: "BRAIN_WORKER_CONFIG_ROOT", description: "Internal immutable configuration execution root for maintenance and hosted turn workers, supplied by the trusted worker launch. Root discovery maps it to BRAIN_WORKER_DATA_ROOT; configuration loading maps the data root back here.", required: false },
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
    name: "BRAIN_COMPUTE_STATE_DIR",
    description:
      "Absolute directory for external compute job records, leases, reservations and artifacts. " +
      "Must lie outside the brain checkout; it is never in brain.config because the brain is agent-editable.",
    default: "$XDG_STATE_HOME/brain/compute/<brain key>",
    required: false,
  },
  {
    name: "XDG_STATE_HOME",
    description: "Base directory for the default external compute state directory.",
    default: "~/.local/state",
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
      "`brain sync` asks, plus opted-in hygiene propagation review. Search also requires reranker.enabled: true; propagation requires hygiene.propagation.enabled: true. " +
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
  {
    name: "APIFY_TOKEN",
    description:
      "Apify API token for a standalone `brain apify` or `brain mcp` process (#3162). Used only while the governance " +
      "policy sets apify.enabled: true, and only as a bearer header to the fixed Apify origins; never printed. " +
      "A chat worker never receives it.",
    default: "unset: Apify refuses as authentication_required",
    required: false,
  },
  {
    name: "BRAIN_APIFY_LEDGER",
    description:
      "Absolute path of the shared Apify ledger a standalone `brain apify` or `brain mcp` process accounts in (#3162): " +
      "the file the UI server opens, so the account's day limit and concurrency bound every process. A chat worker never receives it.",
    default: "unset: every Apify operation refuses as accounting_unavailable",
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
    source: "brain.config `compute.providers.<id>.apiKeyEnv`",
    description:
      "Credential for one external compute provider instance, read on the trusted host at call time " +
      "and never forwarded into a sandbox, a job record or a result (default: the built-in's own name, " +
      "BRAIN_COMPUTE_BOAT_API_KEY for `boat`).",
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
  /** Trusted external Git roots for metadata-only storage inventory, JSON encoded. */
  storageGitRoots: string | undefined;
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
  /** BRAIN_AGENT_RUNNER_UNAVAILABLE is truthy: this worker can run no agent, whatever the brain configures. */
  agentRunnerUnavailable: boolean;
  /** BRAIN_COMPUTE_STATE_DIR, or undefined for the default under the state home. */
  computeStateDir: string | undefined;
  /** XDG_STATE_HOME with the ~/.local/state fallback applied. */
  stateHome: string;
  /** APIFY_TOKEN, trimmed, or undefined when unset or blank. */
  apifyToken: string | undefined;
  /** BRAIN_APIFY_LEDGER, trimmed, or undefined when unset or blank. */
  apifyLedger: string | undefined;
  /** BRAIN_MEDIA_PINNED_PATH_LIMIT, unvalidated (`pinnedPathLimit` validates it). */
  mediaPinnedPathLimit: string | undefined;
  /** BRAIN_MEDIA_REFERENCE_LIMITS, unvalidated (`mediaReferenceLimits` validates it). */
  mediaReferenceLimits: string | undefined;
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
    storageGitRoots: env.BRAIN_STORAGE_GIT_ROOTS,
    rerankMode: env.BRAIN_RERANK_MODE,
    binDir: env.XDG_BIN_HOME || join(homedir(), ".local", "bin"),
    noColor: envPresent(env.NO_COLOR),
    chromeNoSandbox:
      envFlag(env.BRAIN_CHROME_NO_SANDBOX, false) ||
      envFlag(env.BRAIN_UI_CHROME_NO_SANDBOX, false),
    claudeCodePath: env.CLAUDE_CODE_PATH || undefined,
    typesafeApiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
    agentRunnerUnavailable: envFlag(env.BRAIN_AGENT_RUNNER_UNAVAILABLE, false),
    computeStateDir: env.BRAIN_COMPUTE_STATE_DIR || undefined,
    stateHome: env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    apifyToken: env.APIFY_TOKEN?.trim() || undefined,
    apifyLedger: env.BRAIN_APIFY_LEDGER?.trim() || undefined,
    mediaPinnedPathLimit: env.BRAIN_MEDIA_PINNED_PATH_LIMIT,
    mediaReferenceLimits: env.BRAIN_MEDIA_REFERENCE_LIMITS,
  };
}

/** The writable output allowance a trusted maintenance launch declares, or undefined when absent or malformed. */
export function workerOutputAllowance(raw: string | undefined = process.env.BRAIN_WORKER_OUTPUT_ALLOWANCE): { bytes: number; setting: string } | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const { bytes, setting } = value as { bytes?: unknown; setting?: unknown };
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  if (typeof setting !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(setting)) return undefined;
  return { bytes, setting };
}

/** @internal The trusted maintenance or hosted turn launch's separate data and execution roots. */
export function maintenanceConfigRoots(): { data: string | undefined; config: string | undefined } {
  return { data: process.env.BRAIN_WORKER_DATA_ROOT, config: process.env.BRAIN_WORKER_CONFIG_ROOT };
}
