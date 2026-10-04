import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { discoverSkills, lintSkills } from "../../lib/skills/index.js";
import type { LintFinding } from "../../lib/skills/index.js";
import { CORE_COMMAND_NAMES } from "../core-command-names.js";
import type { CoreCommand, CliContext } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";
import { moduleContextTokens } from "../../lib/module-instructions.js";
import { lintModuleTools } from "../../lib/module-tool-lint.js";
import { ModuleToolNameError } from "../../lib/module-tool-names.js";

const HELP = `brain module <list|lint|enable|disable|settings>

  list          Enabled modules + available @schlessera/brain-module-* packages
  lint <name>   Validate an enabled module: manifest, skills, command/type
                collisions, MCP tools, and configSchema against the user's config block
  enable <name> Reactivate a configured module and synchronize owned context
  disable <name> Park workflows while retaining validated config and content
  settings <name> [--set key=value] [--revision REV] --json
                Read or save validated per-module settings
    --migrate [--preview]  Preview/apply a declared lossless content migration

Legacy mixed generated instruction sections require explicit migration first.
See docs/modules.md (instruction migration).`;

function pkgInfo(dir: string): { name?: string; description?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return { name: pkg.name, description: pkg.description };
  } catch {
    return {};
  }
}

/** @schlessera/brain-module-* packages declared in the brain repo's package.json. */
function declaredModulePackages(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.keys(deps).filter((k) => k.startsWith("@schlessera/brain-module-"));
  } catch {
    return [];
  }
}

function moduleList(cli: CliContext): Record<string, unknown> {
  const enabledKeys = new Set(cli.brain.modules.map((m) => m.key));
  const enabled = cli.brain.modules.map((m) => ({
    name: m.manifest.name,
    key: m.key,
    description: pkgInfo(m.dir).description ?? null,
    types: Object.keys(m.manifest.taxonomy?.types ?? {}),
    commands: Object.keys(m.manifest.commands ?? {}),
    tools: Object.keys(m.manifest.tools ?? {}).map((local) => `${m.manifest.name}_${local}`),
    cron: m.state === "dormant" ? [] : m.manifest.cron ?? [],
    state: m.state ?? "active",
    contextTokens: moduleContextTokens(cli.brain.root, cli.brain.modules, m),
    settings: Boolean(m.declaration?.configSchema),
    canBeDormant: m.manifest.canBeDormant ?? true,
    dormancyReason: m.manifest.dormancyReason ?? null,
  }));

  const available = declaredModulePackages(cli.brain.root)
    .filter((key) => !enabledKeys.has(key))
    .map((key) => {
      const dir = resolve(cli.brain.root, "node_modules", key);
      return { key, description: existsSync(dir) ? pkgInfo(dir).description ?? null : null, enabled: false };
    });

  return { enabled, available };
}

/** Recover independent settings without bypassing the loader's name uniqueness. */
async function recoverConfiguredModules(cli: CliContext) {
  const { loadUserConfig } = await import("../../lib/config.js");
  const { importManifest, loadModules } = await import("../../lib/module-loader.js");
  const loaded = await loadUserConfig(cli.brain.root);
  const declarations = await Promise.all(Object.entries(loaded.config?.modules ?? {}).map(async ([key, config]) => {
    let name = key.split("/").at(-1)!.replace(/^brain-module-/, "");
    let error: string | undefined;
    try { name = (await importManifest(key, cli.brain.root)).manifest.name; }
    catch (cause) { error = (cause as Error).message; }
    return { key, config, name, error };
  }));
  const counts = new Map<string, number>();
  for (const declaration of declarations) counts.set(declaration.name, (counts.get(declaration.name) ?? 0) + 1);
  const modules: typeof cli.brain.modules = [];
  const entries: Record<string, unknown>[] = [];
  for (const { key, config, name, error } of declarations) {
    try {
      if (error) throw new Error(error);
      if (counts.get(name)! > 1) throw new Error(`Duplicate module name "${name}" (key: ${key}); repair the configured declarations before editing settings`);
      const independent = await loadModules({ modules: { [key]: config } }, cli.brain.root);
      modules.push(...independent);
      entries.push(...moduleList({ ...cli, brain: { ...cli.brain, modules: independent } }).enabled as Record<string, unknown>[]);
    } catch (cause) {
      entries.push({ name, key, description: null, state: "unavailable", settings: false, error: (cause as Error).message });
    }
  }
  return { modules, entries, loaded };
}

async function moduleLint(cli: CliContext, name: string): Promise<{ findings: LintFinding[] }> {
  const findings: LintFinding[] = [];
  const add = (severity: LintFinding["severity"], rule: string, message: string) =>
    findings.push({ skill: name, rule, severity, message });

  const mod = cli.brain.modules.find((m) => m.manifest.name === name);
  if (!mod) {
    // The loader still rejects malformed declarations for every command.
    // Retain the specific finding when lint is diagnosing that rejection.
    if (cli.configCause instanceof ModuleToolNameError && cli.configCause.moduleName === name) {
      for (const issue of cli.configCause.issues) add("error", "tool-name", issue);
      return { findings };
    }
    add("error", "load", `module "${name}" is not enabled in brain.config (only enabled modules can be linted)`);
    return { findings };
  }

  // Manifest sanity.
  if (typeof mod.manifest.name !== "string" || !mod.manifest.name) {
    add("error", "manifest", "manifest is missing a string `name`");
  }

  // Command-word collisions with core commands (module-vs-module collisions are
  // already caught at registry build time).
  for (const word of Object.keys(mod.manifest.commands ?? {})) {
    if (CORE_COMMAND_NAMES.has(word)) {
      add("error", "command-collision", `command "${word}" collides with a core command`);
    }
  }

  // Type/dir collisions: the taxonomy built at load without throwing, so the
  // module's types are collision-free against the effective taxonomy.
  for (const type of Object.keys(mod.manifest.taxonomy?.types ?? {})) {
    if (!cli.brain.taxonomy.isValidType(type)) {
      add("error", "type", `manifest type "${type}" is not present in the effective taxonomy`);
    }
  }

  // Skills: lint the module's own skills, and surface discovery warnings.
  const { skills, warnings } = discoverSkills({ root: cli.brain.root, modules: [{ ...mod, state: "active" }] });
  const moduleSkills = skills.filter((s) => s.source === "module");
  findings.push(...lintSkills(moduleSkills));
  for (const w of warnings) add("error", "skill-frontmatter", w);
  findings.push(...await lintModuleTools(mod));

  // Config validity needs no re-check here: loadModules() hard-fails on a
  // config the module's configSchema rejects, so a loaded module implies a
  // valid config block.

  return { findings };
}

export const moduleCommand: CoreCommand = {
  summary: "List and lint brain-kit modules",
  helpBlock: HELP,
  async run(args, cli): Promise<number | void> {
    const sub = args[0];

    if (sub === "settings") {
      const { args: pos, flags } = parseArgs(args);
      if (pos.length !== 2) throw new UsageError("Usage: brain module settings <name> [--set key=value] --json");
      const name = pos[1]!;
      let settingsBrain = cli.brain;
      if (cli.configError) {
        if (flags.action) throw new UsageError(cli.configError);
        const { modules, loaded } = await recoverConfiguredModules(cli);
        settingsBrain = { ...cli.brain, modules, configPath: loaded.path, configSource: loaded.content };
      }
      const { getModuleSettings, saveModuleSettings, previewModuleSettings, previewModuleSettingsMigration, migrateModuleSettings, ModuleSettingsError } = await import("../../lib/module-settings.js");
      try {
        let result: unknown;
        if (flags.action) {
          if (flags.set || flags.stdin || flags.migrate) throw new UsageError("Actions use saved settings; save separately first");
          const mod = cli.brain.modules.find((m) => m.manifest.name === name);
          const action = mod?.declaration?.settings?.actions?.find((a) => a.id === flags.action);
          if (!mod || !action) throw new UsageError("Unknown module action");
          const [word, ...actionArgs] = action.command;
          if (!word || !mod.manifest.commands?.[word]) throw new UsageError("Action must use its owning module's CLI namespace");
          const { buildRegistry } = await import("../registry.js");
          return buildRegistry(cli.brain).commands.get(word)!.run(actionArgs, cli);
        } else if (flags.migrate) {
          if (flags.set || flags.stdin) throw new UsageError("Migration is a separate save");
          const preview = previewModuleSettingsMigration(settingsBrain, name);
          result = flags.preview ? preview : migrateModuleSettings(settingsBrain, name, typeof flags.revision === "string" ? flags.revision : preview.revision);
        } else if (flags.stdin || flags.set) {
          const snapshot = getModuleSettings(settingsBrain, name);
          let overrides: unknown = snapshot.overrides;
          if (flags.stdin) overrides = JSON.parse(await Bun.stdin.text());
          else {
            if (typeof flags.set !== "string" || !flags.set.includes("=")) throw new UsageError("--set expects key=value (value may be JSON)");
            const at = flags.set.indexOf("=");
            const path = flags.set.slice(0, at).split(".");
            if (path.some((p) => !p || ["__proto__", "constructor", "prototype"].includes(p))) throw new UsageError("Invalid settings key");
            const raw = flags.set.slice(at + 1);
            let value: unknown;
            try { value = JSON.parse(raw); } catch { value = raw; }
            const { mergeModuleSettings, setModuleSetting } = await import("../../lib/module-settings-source.js");
            overrides = setModuleSetting(snapshot.overrides, mergeModuleSettings(snapshot.inherited, snapshot.overrides), path, value);
          }
          result = flags.preview ? previewModuleSettings(settingsBrain, name, overrides) : saveModuleSettings(settingsBrain, name, overrides, typeof flags.revision === "string" ? flags.revision : snapshot.revision);
        } else result = getModuleSettings(settingsBrain, name);
        emit(cli.json, result, () => console.log(JSON.stringify(result, null, 2)));
        return;
      } catch (error) {
        if (!(error instanceof ModuleSettingsError)) throw error;
        emit(cli.json, { error: error.message, status: error.status, errors: error.errors }, () => console.error(error.message, ...error.errors.map((e) => `${e.path}: ${e.message}`)));
        return 1;
      }
    }

    if (sub === "list") {
      let result = moduleList(cli);
      if (cli.configError) {
        // A bad module must not turn Settings into an empty catalog or hide
        // valid neighbors. Inspect each entry independently without running
        // commands for a rejected config.
        const { entries } = await recoverConfiguredModules(cli);
        result = { enabled: entries, available: [] };
      }
      emit(cli.json, result, () => {
        const enabled = result.enabled as Array<{ name: string; description: string | null; state: string; contextTokens: number }>;
        const available = result.available as Array<{ key: string; description: string | null }>;
        console.log("Enabled modules:");
        for (const m of enabled) console.log(`  ${m.name} — ${m.description ?? "(no description)"}${m.state !== "active" ? ` [${m.state}]` : ""} (${m.contextTokens ?? 0} estimated context tokens when active)`);
        if (enabled.length === 0) console.log("  (none)");
        console.log("\nAvailable (declared but not enabled):");
        for (const m of available) console.log(`  ${m.key} — ${m.description ?? "(not installed)"}`);
        if (available.length === 0) console.log("  (none)");
      });
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const { args: pos } = parseArgs(args);
      if (pos.length !== 2) throw new UsageError(`Usage: brain module ${sub} <name>`);
      const { toggleModule } = await import("../../lib/module-toggle.js");
      const result = toggleModule(cli, pos[1]!, sub === "enable");
      emit(cli.json, result, () => {
        console.log(`Module ${result.module}: ${result.state}${result.changed ? "" : " (unchanged)"}`);
        if (result.context.entered.length) console.log(`Entered context: ${result.context.entered.join(", ")}`);
        if (result.context.left.length) console.log(`Left context: ${result.context.left.join(", ")}`);
      });
      return;
    }

    if (sub === "lint") {
      const name = args[1];
      if (!name) throw new UsageError("Usage: brain module lint <name>");
      const { findings } = await moduleLint(cli, name);
      const errors = findings.filter((f) => f.severity === "error").length;
      emit(cli.json, { module: name, findings, errors }, () => {
        if (findings.length === 0) {
          console.log(`Module "${name}" lint: clean.`);
          return;
        }
        for (const f of findings) console.log(`  [${f.severity.toUpperCase()}] ${f.rule}: ${f.message}`);
        console.log(`\n${errors} error(s)`);
      });
      return errors > 0 ? 1 : 0;
    }

    throw new UsageError("Usage: brain module <list|lint|enable|disable|settings>");
  },
};
