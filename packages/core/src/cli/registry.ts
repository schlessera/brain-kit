/**
 * The command registry: core commands plus one namespaced word per module.
 *
 * Refactors the reference brain's 976-line dispatch switch into a data-driven
 * Map. Core commands register eagerly; module commands register a
 * lazy loader keyed by their manifest word, so heavy module code is only
 * imported when that command actually runs (or when `--help` resolves its
 * summary). A module word colliding with a core name (or another module's word)
 * is a load error surfaced by the bin entry.
 */

import type { BrainContext } from "../lib/context.js";
import type { CommandModule } from "../lib/module-types.js";
import { CORE_COMMANDS } from "./commands/index.js";
import type { CliContext } from "./types.js";

export interface RegisteredCommand {
  name: string;
  /** Eager for core commands; a placeholder for modules until describe() runs. */
  summary: string;
  helpBlock?: string;
  source: "core" | "module";
  run(args: string[], cli: CliContext): Promise<number | void>;
  /** Module commands resolve their real summary/helpBlock lazily (imports the command). */
  describe?(): Promise<{ summary: string; helpBlock?: string }>;
}

export interface Registry {
  commands: Map<string, RegisteredCommand>;
  /** Module collision/load errors, surfaced by the bin as warnings. */
  errors: string[];
}

type Loader = () => Promise<{ default: CommandModule } | CommandModule>;

async function loadModuleCommand(loader: Loader): Promise<CommandModule> {
  const mod = await loader();
  return ((mod as { default?: CommandModule }).default ?? mod) as CommandModule;
}

export function buildRegistry(brain: BrainContext): Registry {
  const commands = new Map<string, RegisteredCommand>();
  const errors: string[] = [];

  for (const [name, cmd] of Object.entries(CORE_COMMANDS)) {
    commands.set(name, {
      name,
      summary: cmd.summary,
      helpBlock: cmd.helpBlock,
      source: "core",
      run: cmd.run,
    });
  }

  for (const mod of brain.modules) {
    for (const [word, loader] of Object.entries(mod.manifest.commands ?? {})) {
      const existing = commands.get(word);
      if (existing) {
        errors.push(
          `module "${mod.manifest.name}" command "${word}" collides with ` +
            (existing.source === "core" ? "a core command" : `module command "${existing.name}"`)
        );
        continue;
      }
      commands.set(word, {
        name: word,
        summary: "(module command)",
        source: "module",
        async run(args, cli) {
          const cmd = await loadModuleCommand(loader as Loader);
          return cmd.run(args, {
            root: cli.brain.root,
            json: cli.json,
            // The module's own validated config + the merged taxonomy, so a
            // module command never re-loads brain.config (the old reload path
            // silently fell back to schema defaults on error).
            config: mod.config,
            taxonomy: cli.brain.taxonomy,
          });
        },
        async describe() {
          const cmd = await loadModuleCommand(loader as Loader);
          return { summary: cmd.summary, helpBlock: cmd.helpBlock };
        },
      });
    }
  }

  return { commands, errors };
}

/**
 * Generate `brain --help`. Header from `profile.cliTitle` (fallback is the
 * generic, non-personal title), then the sorted command list with summaries
 * (module summaries resolved lazily), then the global flags.
 */
export async function helpText(brain: BrainContext, registry: Registry): Promise<string> {
  const title = brain.config?.profile?.cliTitle || "brain — file-first knowledge base";
  const names = [...registry.commands.keys()].sort();

  const rows: Array<[string, string]> = [];
  for (const name of names) {
    const cmd = registry.commands.get(name)!;
    let summary = cmd.summary;
    if (cmd.source === "module" && cmd.describe) {
      try {
        summary = (await cmd.describe()).summary;
      } catch {
        summary = "(module command — failed to load)";
      }
    }
    rows.push([name, summary]);
  }

  const pad = rows.reduce((m, [n]) => Math.max(m, n.length), 0);
  const lines = [
    title,
    "",
    "Usage: brain <command> [args] [flags]",
    "",
    "Commands:",
    ...rows.map(([name, summary]) => `  ${name.padEnd(pad)}  ${summary}`),
    "",
    "Global flags:",
    "  --json      Force JSON output",
    "  --human     Force human-readable output",
    "  --help      Show help (append to a command for its usage)",
    "  --version   Show the installed @schlessera/brain version",
  ];
  return lines.join("\n");
}
