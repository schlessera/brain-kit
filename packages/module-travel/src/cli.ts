import { existsSync, lstatSync, readFileSync } from "fs";
import { join } from "path";
import { safeResolve, writeFileSafely } from "@schlessera/brain";
import type { CommandContext, CommandModule } from "@schlessera/brain";
import { readTravelCorpus } from "./content.js";
import type { TravelConfig } from "./module.js";

const HELP = `brain travel — journey, day-trip and place foundations

  travel validate              Check canonical formats, references and assets
  travel migrate [--dry-run]    Move legacy speaking travelParty without changing content
  travel photo <files> --to <dir>  Create reduced JPEG copies without metadata
  travel route <url|file> --to <dir> [--trim-start-m N] [--trim-end-m N]
                               Normalize GPX/Komoot geometry, report metrics, trim distance

Flags: --json  emit the documented envelope; --human  display photo paths and dimensions`;

async function migrate(root: string, dryRun: boolean): Promise<{ path: string; changed: boolean; dry_run: boolean }> {
  // This is an explicit source migration, not a second effective-config reader.
  // Normal commands use ctx.config. Never serialize evaluated TS configuration.
  const name = existsSync(join(root, "brain.config.ts")) ? "brain.config.ts" : "brain.config.json";
  const original = join(root, name);
  if (!existsSync(original)) throw new Error("No canonical brain.config found; enable the travel module before migrating.");
  if (lstatSync(original).isSymbolicLink()) throw new Error("Config is a symlink; no changes made. Migrate the actual config explicitly.");
  const path = safeResolve(root, name);
  if (!path) throw new Error("Config escapes the brain root; no changes made.");
  // #528 owns the future JSON settings precedence and validated writer. Refuse
  // to guess when those sources are already present, and never overwrite them.
  for (const module of ["speaking", "travel"]) {
    if (existsSync(join(root, "settings", `${module}.json`))) {
      throw new Error(`settings/${module}.json already exists; no changes made. Review it with the module-settings migration before moving canonical configuration.`);
    }
  }
  const source = readFileSync(path, "utf8");
  const { planTravelConfigMigration } = await import("./migration.js");
  const plan = planTravelConfigMigration(source, name.endsWith(".ts") ? "ts" : "json");
  if (plan.changed && !dryRun) {
    if (readFileSync(path, "utf8") !== source) throw new Error("Config changed during migration; no changes made. Run the migration again.");
    writeFileSafely(path, plan.source);
  }
  return { path: name, changed: plan.changed, dry_run: dryRun };
}

const command: CommandModule<TravelConfig> = {
  summary: "Validate travel content, migrate travel configuration, prepare photo copies and import routes",
  helpBlock: HELP,
  async run(args: string[], ctx: CommandContext<TravelConfig>): Promise<number> {
    const sub = args[0];
    if (sub === "photo") {
      try {
        const files: string[] = [];
        let to: string | undefined;
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          if (arg === "--") { files.push(...args.slice(i + 1)); break; }
          if (arg === "--json" || arg === "--human") continue;
          if (arg === "--to") {
            if (to !== undefined || !args[i + 1] || args[i + 1].startsWith("-")) throw new Error("photo requires exactly one --to directory.");
            to = args[++i];
          } else if (arg.startsWith("-")) throw new Error("Unknown photo argument: " + arg + ". Use -- before a filename starting with a dash.");
          else files.push(arg);
        }
        if (!files.length || to === undefined) throw new Error("Usage: brain travel photo <files> --to <dir> [--json]");
        const { preparePhotos } = await import("./photo.js");
        const photo = await preparePhotos(ctx.root, files, to);
        if (ctx.json) console.log(JSON.stringify({ photo }, null, 2));
        else {
          for (const file of photo.files) console.log(file.source + " → " + file.output + " (" + file.width + "×" + file.height + ")");
          for (const error of photo.errors) console.error(error.source + ": " + error.message);
        }
        return photo.errors.length ? 2 : 0;
      } catch (error) { console.error((error as Error).message); return 1; }
    }
    if (sub === "route") return (await import("./route.js")).runRoute(args.slice(1), ctx.root, ctx.json);
    if (sub !== "validate" && sub !== "migrate") { console.error(HELP); return 1; }
    if (args.slice(1).some((arg) => arg !== "--json" && arg !== "--human" && !(sub === "migrate" && arg === "--dry-run"))) {
      console.error(`Unknown travel argument.\n${HELP}`); return 1;
    }
    if (sub === "validate") {
      const corpus = readTravelCorpus(ctx.root, ctx.taxonomy);
      const validation = { valid: !corpus.issues.length, files: corpus.documents.size, issues: corpus.issues };
      if (ctx.json) console.log(JSON.stringify({ validation }, null, 2));
      else {
        for (const issue of validation.issues) console.log(`${issue.file}: ${issue.message}`);
        console.log(validation.valid ? `${validation.files} travel documents valid.` : `${validation.issues.length} travel validation errors.`);
      }
      return validation.valid ? 0 : 1;
    }
    try {
      const migration = await migrate(ctx.root, args.includes("--dry-run"));
      if (ctx.json) console.log(JSON.stringify({ migration }, null, 2));
      else console.log(migration.changed
        ? `${migration.dry_run ? "Would migrate" : "Migrated"} travelParty in ${migration.path}; content paths and bytes are unchanged.`
        : "Travel configuration already migrated; nothing changed.");
      return 0;
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
  },
};
export default command;
