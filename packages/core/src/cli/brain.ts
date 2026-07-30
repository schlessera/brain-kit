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

import { buildTaxonomy } from "../lib/taxonomy";
import { resolveRoot } from "../lib/config";
import { CONFIG_FILENAMES } from "../lib/config";
import { existsSync } from "fs";
import { initContext } from "../lib/context";
import type { BrainContext } from "../lib/context";
import { createEnrichment } from "../lib/enrichment";
import type { Enrichment } from "../lib/enrichment";
import {
  resolveAgentRunner,
  resolveCompletionProvider,
  resolveEmbeddingProvider,
} from "../lib/registry";
import type { AgentRunner, CompletionProvider, EmbeddingProvider } from "../lib/seams";

import { buildRegistry, helpText } from "./registry";
import type { CliContext } from "./types";
import { computeJson, UsageError } from "./io";

// Commands that must still run when brain.config is missing or invalid — they
// either report the config problem or operate on core-default taxonomy.
const TOLERATE_CONFIG_ERROR = new Set([
  "init", "doctor", "setup", "config", "validate", "module", "skills",
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
]);

/** Env var holding the API key for a named built-in completion provider. */
const COMPLETION_KEY_ENV: Record<string, string> = {
  "gemini-flash": "GEMINI_API_KEY",
  "anthropic-haiku": "ANTHROPIC_API_KEY",
};

function completionEntryAvailable(entry: unknown): boolean {
  if (entry === undefined) return !!process.env.GEMINI_API_KEY; // default gemini-flash
  if (typeof entry !== "string") return true; // custom provider value
  const env = COMPLETION_KEY_ENV[entry];
  return env ? !!process.env[env] : true; // unknown built-in name → let the resolver decide
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
      if (process.env[keyEnv]) embeddings = resolveEmbeddingProvider(embCfg);
    }
  } catch (e) {
    console.error(`Warning: embedding provider unavailable — ${(e as Error).message}`);
  }

  let completions: CompletionProvider | undefined;
  try {
    const cfg = config?.completions;
    const available = cfg
      ? completionEntryAvailable(cfg.provider) ||
        (cfg.fallback !== undefined && completionEntryAvailable(cfg.fallback))
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
  const json = computeJson(argv);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;

  // Load the brain context, tolerating a missing/invalid config.
  let brain: BrainContext;
  let configError: string | undefined;
  try {
    brain = await initContext();
  } catch (e) {
    configError = (e as Error).message;
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
    return 0;
  }

  // An invalid config blocks commands that depend on a correct taxonomy.
  if (configError && !TOLERATE_CONFIG_ERROR.has(command)) {
    console.error(`Invalid brain.config:\n${configError}`);
    return 1;
  }

  // No config found at all → refuse anything that writes.
  if (brain.configPath === null && MUTATING_COMMANDS.has(command)) {
    console.error(
      `No ${CONFIG_FILENAMES.join(" or ")} found from ${process.cwd()} — ` +
        `refusing to modify an uninitialized directory.\n` +
        `Run \`brain init\` to create a brain here, or point BRAIN_ROOT at an existing brain.`
    );
    return 1;
  }

  const providers = resolveProviders(brain);
  const cli: CliContext = { brain, json, configError, ...providers };

  const code = await entry.run(argv.slice(1), cli);
  return typeof code === "number" ? code : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err?.message || err);
    // Exit 2 distinguishes internal failures from usage errors (exit 1).
    process.exit(2);
  });
