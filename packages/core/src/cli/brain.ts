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
import { isReadOnlyBrainMount, readOnlyBrainError } from "./read-only.js";
import { Console } from "node:console";

import { buildTaxonomy } from "../lib/taxonomy.js";
import { resolveRoot } from "../lib/config.js";
import { CONFIG_FILENAMES } from "../lib/config.js";
import { existsSync } from "fs";
import { initContext } from "../lib/context.js";
import type { BrainContext } from "../lib/context.js";
import { createEnrichment } from "../lib/enrichment.js";
import type { Enrichment } from "../lib/enrichment.js";
import { packageVersion } from "../package-version.js";
import { resolveProviders, type ResolvedProviders } from "../lib/registry.js";

import { buildRegistry, helpText } from "./registry.js";
import type { CliContext } from "./types.js";
import { computeJson, parseArgs, scanCliArgs, UsageError } from "./io.js";

// Commands that must still run when brain.config is missing or invalid — they
// either report the config problem or operate on core-default taxonomy.
const TOLERATE_CONFIG_ERROR = new Set([
  "queue", "schedule", "init", "doctor", "setup", "config", "validate", "module", "skills", "mcp", "okf",
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
// `brain hygiene` writes under `reconcile` without --dry-run, and under
// `dismiss` and `snooze`;
// `brain registry` rewrites index tables unless --check.
const MUTATING_WITH_FLAGS: Record<string, (args: string[]) => boolean> = {
  geo: (args) => args[0] === "map",
  tags: (args) => args.includes("--apply") && !args.includes("--dry-run"),
  hygiene: (args) => (args[0] === "reconcile" && !args.includes("--dry-run")) || args[0] === "dismiss" || args[0] === "snooze",
  registry: (args) => !args.includes("--check"),
};

/**
 * Providers for a command, with availability decided by the registry. Each
 * unresolvable seam is reported on stderr rather than crashing the CLI.
 */
function cliProviders(brain: BrainContext): Omit<ResolvedProviders, "warnings"> & { enrichment?: Enrichment } {
  const { warnings, ...providers } = resolveProviders(brain.config);
  for (const warning of [warnings.embeddings, warnings.completions, warnings.agentRunner]) {
    if (warning) console.error(`Warning: ${warning}`);
  }
  return { ...providers, enrichment: providers.completions ? createEnrichment(providers.completions) : undefined };
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

  // Read the actual positional subcommand, including one after `--`.
  const hygieneArgs = command === "hygiene" ? parseArgs(argv.slice(1)) : null;
  const hygienePositionals = hygieneArgs?.args ?? [];
  const hygieneNext = hygienePositionals[0] === "next";
  // An invalid config blocks commands that depend on a correct taxonomy.
  const configBlockerCheck = hygienePositionals[0] === "check" && hygienePositionals[1] === "configuration-blocker";
  const hygieneRepairWrite = (["resolve", "undo"].includes(hygienePositionals[0]) && hygieneArgs?.flags["dry-run"] !== true) ||
    (hygienePositionals[0] === "check" && !configBlockerCheck);
  if (configError && !TOLERATE_CONFIG_ERROR.has(command) && !hygieneNext && !configBlockerCheck) {
    console.error(`Invalid brain.config:\n${configError}`);
    return 1;
  }

  // No config found at all → refuse anything that writes.
  const mutatingSub = MUTATING_SUBCOMMAND[command];
  const mutates = hygieneNext || hygieneRepairWrite ||
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

  // Refuse known write forms before handlers which intentionally collect
  // per-file errors; those loops cannot surface EROFS to main's catch.
  if (mutates && !beforeTerminator(argv.slice(1)).includes("--dry-run") && isReadOnlyBrainMount(brain.root)) {
    const refusal = readOnlyBrainError(command, { code: "EROFS" })!;
    if (json) console.log(JSON.stringify(refusal));
    else console.error(refusal.error.message);
    return 2;
  }

  const providers = cliProviders(brain);
  const cli: CliContext = { brain, json, configError, configCause, ...providers };

  try {
    const code = await entry.run(argv.slice(1), cli);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    const refusal = readOnlyBrainError(command, error);
    if (!refusal) throw error;
    if (json) console.log(JSON.stringify(refusal));
    else console.error(refusal.error.message);
    return 2;
  }
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
