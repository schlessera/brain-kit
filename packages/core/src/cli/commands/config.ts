import { relative, sep } from "path";

import type { CoreCommand, CliContext } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";
import { mediaPolicy } from "../../lib/media.js";

const HELP = `brain config <check|get|media>

  check                Validate the config and print the effective taxonomy summary
  get <dotted.path>    Print a resolved config value as JSON (used by skills)
  media <add-track|remove-track|add-ignore|remove-ignore> <pattern>
      [--dry-run | --expect-sha <sha256> [--expect-approval <digest>]]
                       Change one media.track or media.ignore entry by a minimal
                       splice; the config is edited as syntax and never evaluated.
                       --dry-run previews: { "status": "preview", "op", "pattern",
                       "scope": "exact"|"pattern", "config": { "path", "sha256" },
                       "configDiff", "matches": { "pattern", "anyFolder", "count",
                       "bytes", "changed", "ignoredStill", "sensitive", "largest",
                       "digest" }, "approvalDigest", "refusals" }. Apply needs the
                       preview's config sha256, and with --expect-approval its
                       approvalDigest: { "status": "applied", "op", "pattern",
                       "config": { "path", "before", "after" }, "configDiff" }.
                       Otherwise { "status": "refused"|"stale", "op", "pattern",
                       "reason", "refusals" } and nothing is written; reasons are
                       stale, stale-approval, already-listed, not-listed,
                       not-expressible, invalid-pattern, config-not-literal and
                       config-invalid.`;

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
    const { args: pos, flags } = parseArgs(args);
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

    if (sub === "media") {
      // Loaded only for this verb: the edit's dependencies stay out of every other one.
      const { applyMediaConfigChange, MEDIA_CONFIG_OPS, planMediaConfigChange } = await import("../../lib/media-config.js");
      const op = pos[1], pattern = pos[2];
      if (!MEDIA_CONFIG_OPS.includes(op as (typeof MEDIA_CONFIG_OPS)[number]) || pattern === undefined || pos.length !== 3) {
        throw new UsageError("Usage: brain config media <add-track|remove-track|add-ignore|remove-ignore> <pattern> [--dry-run | --expect-sha <sha256> [--expect-approval <digest>]]");
      }
      if (cli.configError) throw new UsageError(`Invalid brain.config: ${cli.configError}; no changes made`);
      const configPath = cli.brain.configPath === null ? null : relative(cli.brain.root, cli.brain.configPath).split(sep).join("/");
      const ctx = { root: cli.brain.root, policy: mediaPolicy(cli.brain.config), configPath };
      const kind = op as (typeof MEDIA_CONFIG_OPS)[number];
      let result;
      if (flags["dry-run"] === true) result = planMediaConfigChange(ctx, kind, pattern);
      else {
        const sha = flags["expect-sha"], approval = flags["expect-approval"];
        if (typeof sha !== "string" || (approval !== undefined && typeof approval !== "string")) {
          throw new UsageError("Preview with --dry-run first, then apply with --expect-sha <config sha256> [--expect-approval <approvalDigest>]");
        }
        result = applyMediaConfigChange(ctx, kind, pattern, { sha256: sha, ...(typeof approval === "string" ? { approval } : {}) });
      }
      emit(cli.json, result, () => console.log(JSON.stringify(result, null, 2)));
      return ["preview", "applied"].includes(result.status) ? 0 : 1;
    }

    throw new UsageError("Usage: brain config <check|get|media>");
  },
};
