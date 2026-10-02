#!/usr/bin/env bun
/**
 * brain — the CLI bin entry.
 *
 * Ports brain-cli.ts's main(): output-mode detection, dispatch, and the 0/1/2
 * exit-code contract (0 success, 1 usage error, 2 internal failure). New here:
 * a config-driven command registry (registry.ts), provider resolution from
 * brain.config (registry.ts library) with keyless degradation, and tolerance
 * for a missing/invalid config so init/doctor/setup/config still run.
 */

import { join } from "path";
import { Console } from "node:console";

import { readEnvVar } from "../config/env.js";

import { buildTaxonomy } from "../lib/taxonomy.js";
import { resolveRoot } from "../lib/config.js";
import { CONFIG_FILENAMES } from "../lib/config.js";
import { existsSync } from "fs";
import { initContext } from "../lib/context.js";
import type { BrainContext } from "../lib/context.js";
import { createEnrichment } from "../lib/enrichment.js";
import type { Enrichment } from "../lib/enrichment.js";
import { packageVersion } from "../package-version.js";
import {
  resolveAgentRunner,
  resolveCompletionProvider,
  resolveEmbeddingProvider,
} from "../lib/registry.js";
import type { AgentRunner, CompletionProvider, EmbeddingProvider } from "../lib/seams.js";

import { buildRegistry, helpText } from "./registry.js";
import type { CliContext } from "./types.js";
import { computeJson, scanCliArgs, UsageError } from "./io.js";

// Commands that must still run when brain.config is missing or invalid — they
// either report the config problem or operate on core-default taxonomy.
const TOLERATE_CONFIG_ERROR = new Set([
  "queue", "init", "doctor", "setup", "config", "validate", "module", "skills", "mcp", "okf",
]);

// Commands that write to the brain tree or its database. They refuse to run
// when no brain.config was found: resolveRoot's .git-ancestor/cwd fallbacks
// would otherwise let e.g. `brain index` create a brain.db in any directory
// the CLI happens to be invoked from.
const MUTATING_COMMANDS = new Set([
  "add", "import", "index", "archive", "accept-mtime", "process", "maintain", "sync",
  // skills sync writes/deletes under .agents/.claude; setup writes git hooks,
  // skill links, and a ~/.local/bin symlink. Both stay in TOLERATE_CONFIG_ERROR
  // (that list is about an INVALID config); with NO config they must refuse
  // like every other writer. `brain init` writes the config before setup runs.
  "skills", "setup",
  // graph compute rebuilds the derived tables through a writable open.
  "graph",
  // render writes the rendered file into the repo.
  "render",
  // scratch removes files from the brain's scratch area.
  "scratch",
]);

/**
 * Commands from the set above that only write in ONE subcommand form; the rest
 * of their surface is read-only and must keep working in an uninitialized
 * directory (`skills lint`, `graph export`, `graph stats`).
 */
const MUTATING_SUBCOMMAND: Record<string, string> = {
  skills: "sync",
  graph: "compute",
};

/**
 * The arguments that can be flags: everything before a `--`. After it every
 * argument is positional, as `parseArgs` reads them, so `brain registry --
 * --check` is not a check and must be classified as the write it runs as.
 */
function beforeTerminator(args: string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

// Commands that write only under a flag, or only without one: `brain tags`
// reports, and rewrites frontmatter only with --apply and no --dry-run;
// `brain hygiene` writes only under `reconcile` without --dry-run;
// `brain registry` rewrites index tables unless --check.
const MUTATING_WITH_FLAGS: Record<string, (args: string[]) => boolean> = {
  geo: (args) => args[0] === "map",
  tags: (args) => args.includes("--apply") && !args.includes("--dry-run"),
  hygiene: (args) => args[0] === "reconcile" && !args.includes("--dry-run"),
  registry: (args) => !args.includes("--check"),
};

/** Env var holding the API key for a named built-in completion provider. */
const COMPLETION_KEY_ENV: Record<string, string> = {
  "gemini-flash": "GEMINI_API_KEY",
  "anthropic-haiku": "ANTHROPIC_API_KEY",
};

function completionEntryAvailable(entry: unknown, apiKeyEnv?: string): boolean {
  if (entry === undefined) return !!readEnvVar(apiKeyEnv ?? "GEMINI_API_KEY"); // default gemini-flash
  if (typeof entry !== "string") return true; // custom provider value
  const env = apiKeyEnv ?? COMPLETION_KEY_ENV[entry];
  return env ? !!readEnvVar(env) : true; // unknown built-in name → let the resolver decide
}

/**
 * Resolve providers from config. Each is left undefined when its API key is
 * absent, so search/index/enrichment degrade to the same keyless behaviour the
 * reference brain had with no configured key. Resolution errors (bad built-in
 * name) degrade to undefined with a stderr note rather than crashing the CLI.
 */
function resolveProviders(brain: BrainContext): {
  embeddings?: EmbeddingProvider;
  completions?: CompletionProvider;
  enrichment?: Enrichment;
  agentRunner?: AgentRunner;
} {
  const config = brain.config;

  let embeddings: EmbeddingProvider | undefined;
  try {
    const embCfg = config?.embeddings;
    const custom = embCfg && typeof embCfg.provider !== "string";
    if (custom) {
      embeddings = resolveEmbeddingProvider(embCfg);
    } else {
      const keyEnv = embCfg?.apiKeyEnv ?? "GEMINI_API_KEY";
      if (readEnvVar(keyEnv)) embeddings = resolveEmbeddingProvider(embCfg);
    }
  } catch (e) {
    console.error(`Warning: embedding provider unavailable — ${(e as Error).message}`);
  }

  let completions: CompletionProvider | undefined;
  try {
    const cfg = config?.completions;
    const available = cfg
      ? completionEntryAvailable(cfg.provider, cfg.apiKeyEnv) ||
        (cfg.fallback !== undefined && completionEntryAvailable(cfg.fallback, cfg.fallbackApiKeyEnv))
      : completionEntryAvailable(undefined);
    if (available) completions = resolveCompletionProvider(cfg);
  } catch (e) {
    console.error(`Warning: completion provider unavailable — ${(e as Error).message}`);
  }
  const enrichment = completions ? createEnrichment(completions) : undefined;

  let agentRunner: AgentRunner | undefined;
  try {
    agentRunner = resolveAgentRunner(config?.agentRunner);
  } catch (e) {
    console.error(`Warning: agent runner unavailable — ${(e as Error).message}`);
  }

  return { embeddings, completions, enrichment, agentRunner };
}

function detectConfigPath(root: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    if (existsSync(join(root, name))) return join(root, name);
  }
  return null;
}

/** Build a degraded context (core-default taxonomy) when initContext throws. */
function degradedContext(): BrainContext {
  const root = resolveRoot();
  return {
    root,
    dbPath: join(root, "brain.db"),
    config: null,
    configPath: detectConfigPath(root),
    modules: [],
    taxonomy: buildTaxonomy({}),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(packageVersion());
    return 0;
  }
  const json = computeJson(argv);
  const { command, wantsHelp } = scanCliArgs(argv);

  // Load the brain context, tolerating a missing/invalid config.
  let brain: BrainContext;
  let configError: string | undefined;
  let configCause: unknown;
  try {
    brain = await initContext();
  } catch (e) {
    configError = (e as Error).message;
    configCause = e;
    brain = degradedContext();
  }

  const registry = buildRegistry(brain);
  for (const err of registry.errors) {
    console.error(`Warning: ${err}`);
  }

  // No command → global help.
  if (!command) {
    console.log(await helpText(brain, registry));
    return 0;
  }

  const entry = registry.commands.get(command);
  if (!entry) {
    // Invalid module settings prevent its namespace from being registered.
    // Preserve the loader's corrective diagnostic instead of hiding it.
    if (configError) {
      console.error(`Invalid brain.config:\n${configError}`);
      return 1;
    }
    console.error(`Unknown command: ${command}`);
    console.error("Run `brain --help` for usage information.");
    return 1;
  }

  // `brain <cmd> --help` → that command's usage block.
  if (wantsHelp) {
    let help = entry.helpBlock;
    if (!help && entry.describe) {
      try {
        help = (await entry.describe()).helpBlock;
      } catch {
        /* fall back to summary */
      }
    }
    console.log(help ?? entry.summary);
    return entry.helpExitCode ?? 0;
  }

  // An invalid config blocks commands that depend on a correct taxonomy.
  if (configError && !TOLERATE_CONFIG_ERROR.has(command)) {
    console.error(`Invalid brain.config:\n${configError}`);
    return 1;
  }

  // No config found at all → refuse anything that writes.
  const mutatingSub = MUTATING_SUBCOMMAND[command];
  const mutates =
    (MUTATING_COMMANDS.has(command) && (mutatingSub === undefined || argv[1] === mutatingSub)) ||
    (MUTATING_WITH_FLAGS[command]?.(beforeTerminator(argv.slice(1))) ?? false);
  if (brain.configPath === null && mutates) {
    console.error(
      `No ${CONFIG_FILENAMES.join(" or ")} found from ${process.cwd()} — ` +
        `refusing to modify an uninitialized directory.\n` +
        `Run \`brain init\` to create a brain here, or point BRAIN_ROOT at an existing brain.`
    );
    return 1;
  }

  const providers = resolveProviders(brain);
  const cli: CliContext = { brain, json, configError, configCause, ...providers };

  const code = await entry.run(argv.slice(1), cli);
  return typeof code === "number" ? code : 0;
}

// Bun's native console can bypass the stream's pending-write accounting after
// process.stdout is initialized. Use the stream-backed Console so its writes,
// including command/library diagnostics, join direct stdout/stderr writes.
const streamConsole = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
  ignoreErrors: false,
});
Object.assign(console, {
  log: streamConsole.log,
  error: streamConsole.error,
  warn: streamConsole.warn,
  info: streamConsole.info,
  debug: streamConsole.debug,
});

let outputError = false;
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => { outputError = true; });
}

async function finish(code: number): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((resolve) => {
      if (stream.destroyed) return resolve();
      const done = () => {
        stream.off("error", done);
        resolve();
      };
      stream.once("error", done);
      stream.end(done);
    })
  ));
  // Only stdio completion delays exit; provider sockets/timers cannot keep a
  // finished command alive. An output failure is an internal failure.
  process.exit(outputError ? 2 : code);
}

main().then(finish, (err) => {
  console.error(err?.message || err);
  // Exit 2 distinguishes internal failures from usage errors (exit 1).
  return finish(err instanceof UsageError ? 1 : 2);
});
