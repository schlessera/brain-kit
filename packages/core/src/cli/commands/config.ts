import type { CoreCommand, CliContext } from "../types";
import { emit, parseArgs, UsageError } from "../io";

const HELP = `brain config <check|get>

  check                Validate the config and print the effective taxonomy summary
  get <dotted.path>    Print a resolved config value as JSON (used by skills)`;

/** Effective-taxonomy summary for `config check`. */
function taxonomySummary(cli: CliContext): Record<string, unknown> {
  const tax = cli.brain.taxonomy;
  const types: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tax.types)) {
    types[name] = { dir: spec.dir, owner: spec.owner, prefixes: spec.prefixes };
  }
  return {
    types,
    inbox: tax.inboxType(),
    canonical: tax.canonical,
    dirAnchors: tax.dirAnchors,
    modules: cli.brain.modules.map((m) => m.manifest.name),
  };
}

/** Navigate a dotted path through a plain object/array. */
function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export const configCommand: CoreCommand = {
  summary: "Validate config / read effective taxonomy and config values",
  helpBlock: HELP,
  async run(args, cli): Promise<number | void> {
    const { args: pos } = parseArgs(args);
    const sub = pos[0];

    if (sub === "check") {
      if (cli.configError) {
        emit(cli.json, { valid: false, error: cli.configError }, () => {
          console.log("Config invalid:");
          console.log(cli.configError);
        });
        return 1;
      }
      const summary = {
        valid: true,
        path: cli.brain.configPath,
        taxonomy: taxonomySummary(cli),
      };
      emit(cli.json, summary, () => {
        console.log(`Config OK: ${cli.brain.configPath ?? "(none — core defaults)"}`);
        console.log(`Types: ${Object.keys(cli.brain.taxonomy.types).join(", ")}`);
        console.log(`Inbox: ${cli.brain.taxonomy.inboxType()}`);
        console.log(`Modules: ${cli.brain.modules.map((m) => m.manifest.name).join(", ") || "(none)"}`);
      });
      return;
    }

    if (sub === "get") {
      const dotted = pos[1];
      if (!dotted) throw new UsageError("Usage: brain config get <dotted.path>");
      const value = getPath(cli.brain.config ?? {}, dotted);
      // Always JSON — skills consume this programmatically.
      console.log(JSON.stringify(value ?? null, null, 2));
      return;
    }

    throw new UsageError("Usage: brain config <check|get>");
  },
};
