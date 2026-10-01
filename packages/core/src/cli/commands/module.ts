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

const HELP = `brain module <list|lint|enable|disable>

  list          Enabled modules + available @schlessera/brain-module-* packages
  lint <name>   Validate an enabled module: manifest, skills, command/type
                collisions, MCP tools, and configSchema against the user's config block
  enable <name> Reactivate a configured module and synchronize owned context
  disable <name> Park workflows while retaining validated config and content

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
  }));

  const available = declaredModulePackages(cli.brain.root)
    .filter((key) => !enabledKeys.has(key))
    .map((key) => {
      const dir = resolve(cli.brain.root, "node_modules", key);
      return { key, description: existsSync(dir) ? pkgInfo(dir).description ?? null : null, enabled: false };
    });

  return { enabled, available };
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

    if (sub === "list") {
      const result = moduleList(cli);
      emit(cli.json, result, () => {
        const enabled = result.enabled as Array<{ name: string; description: string | null; state: string; contextTokens: number }>;
        const available = result.available as Array<{ key: string; description: string | null }>;
        console.log("Enabled modules:");
        for (const m of enabled) console.log(`  ${m.name} — ${m.description ?? "(no description)"}${m.state === "dormant" ? " [dormant]" : ""} (${m.contextTokens} estimated context tokens when active)`);
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

    throw new UsageError("Usage: brain module <list|lint|enable|disable>");
  },
};
