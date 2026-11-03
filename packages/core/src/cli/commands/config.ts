import type { CoreCommand, CliContext } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

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

/**
 * External compute as data, for a host that reads the configuration without
 * running it (#3108). A built-in instance is reported whole; an instance
 * whose provider is a value is reported by its id only, `provider: null` and
 * `byValue: true`, because a value is code the host never runs. Credentials
 * are named, never resolved.
 */
export function computeSummary(config: CliContext["brain"]["config"]): Record<string, unknown> {
  const providers = config?.compute?.providers;
  if (!providers) return { enabled: false, providers: {} };
  const summary: Record<string, unknown> = {};
  for (const id of Object.keys(providers).sort()) {
    const entry = providers[id]!;
    const limits = {
      lease: { maxSeconds: entry.lease.maxSeconds },
      maxConcurrent: entry.maxConcurrent ?? null,
      hourlyCeilingUsd: entry.hourlyCeilingUsd ?? null,
      retainOnRelease: entry.retainOnRelease ?? null,
    };
    summary[id] = typeof entry.provider === "string"
      ? { provider: entry.provider, byValue: false, apiKeyEnv: entry.apiKeyEnv ?? null, options: entry.options ?? null, ...limits }
      : { provider: null, byValue: true, apiKeyEnv: null, options: null, ...limits };
  }
  return { enabled: true, providers: summary };
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
        compute: computeSummary(cli.brain.config),
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
      const effective = { ...cli.brain.config, ...(cli.brain.config?.modules ? { modules: Object.fromEntries(cli.brain.modules.map((m) => [m.key, {
        ...(m.config as Record<string, unknown>),
        ...(typeof (cli.brain.config?.modules?.[m.key] as Record<string, unknown> | undefined)?.enabled === "boolean"
          ? { enabled: (cli.brain.config!.modules![m.key] as Record<string, unknown>).enabled } : {}),
      }])) } : {}) };
      const value = getPath(effective, dotted);
      // Always JSON — skills consume this programmatically.
      console.log(JSON.stringify(value ?? null, null, 2));
      return;
    }

    throw new UsageError("Usage: brain config <check|get>");
  },
};
