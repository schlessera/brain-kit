import { existsSync, readFileSync } from "fs";
import type { CliContext } from "../cli/types.js";
import { resolveEmitters } from "../cli/skills-util.js";
import { UsageError } from "../cli/io.js";
import { planModuleFlag } from "./module-config-edit.js";
import { planModuleInstructions } from "./module-instructions.js";
import { discoverSkills } from "./skills/discover.js";
import { syncSkills } from "./skills/sync.js";
import { safeResolve, writeFileSafely } from "./safe-path.js";
import type { LoadedModule } from "./module-types.js";
import { readGeneratedRegion } from "./generated-regions.js";

export function toggleModule(cli: CliContext, name: string, enabled: boolean): {
  module: string;
  state: "active" | "dormant";
  changed: boolean;
  context: { entered: string[]; left: string[] };
} {
  const brain = cli.brain;
  if (cli.configError) throw new UsageError(`Invalid brain.config: ${cli.configError}; no changes made`);
  const mod = brain.modules.find((m) => m.manifest.name === name);
  if (!mod || !brain.configPath) throw new UsageError(`Module "${name}" is not configured; add its validated config entry first`);
  if (!enabled && mod.manifest.canBeDormant === false) {
    throw new UsageError(`Module "${name}" cannot be dormant: ${mod.manifest.dormancyReason ?? "the manifest requires its workflow to remain active"}`);
  }
  const state = enabled ? "active" : "dormant";
  const modules: LoadedModule[] = brain.modules.map((m) => m === mod ? { ...m, state } : m);
  const path = safeResolve(brain.root, brain.configPath);
  if (!path) throw new UsageError("Config resolves outside the brain root; no changes made");
  const original = readFileSync(path, "utf8");
  // All source, ownership, discovery and emitter checks precede every write.
  const instructions = planModuleInstructions(brain, modules);
  const config = (mod.state ?? "active") === state ? original
    : planModuleFlag(original, brain.configPath.endsWith(".json") ? "json" : "ts", mod.key, enabled);
  const { emitters, warnings } = resolveEmitters(brain);
  const before = discoverSkills({ root: brain.root, modules: brain.modules });
  const after = discoverSkills({ root: brain.root, modules });
  const problems = [...warnings, ...after.warnings];
  if (problems.length) throw new UsageError(`Cannot synchronize module context: ${problems.join("; ")}; no changes made`);
  if (readFileSync(path, "utf8") !== original || instructions.some((e) =>
    e.before === null ? existsSync(e.path) : readFileSync(e.path, "utf8") !== e.before)) {
    throw new UsageError("Config or instructions changed during the toggle; no changes made, retry after reviewing them");
  }
  if (config !== original) writeFileSafely(path, config);
  for (const e of instructions) writeFileSafely(e.path, e.after);
  const synced = syncSkills({ root: brain.root, modules }, { emitters });
  if (synced.warnings.length) throw new Error(`Module state is ${state}, but context sync needs repair: ${synced.warnings.join("; ")}. Retry brain module ${enabled ? "enable" : "disable"} ${name}`);
  const oldSkills = new Map(before.skills.map((s) => [s.name, s]));
  const newSkills = new Map(after.skills.map((s) => [s.name, s]));
  const differs = (a: typeof before.skills[number], b: typeof before.skills[number] | undefined) =>
    !b || a.description !== b.description || a.dir !== b.dir;
  const entered = after.skills.filter((s) => differs(s, oldSkills.get(s.name))).map((s) => s.name);
  const left = before.skills.filter((s) => differs(s, newSkills.get(s.name))).map((s) => s.name);
  for (const m of modules) {
    if (!m.manifest.instructions) continue;
    const region = `module-${m.manifest.name}`;
    const oldText = instructions.map((e) => readGeneratedRegion(e.before ?? "", region));
    const newText = instructions.map((e) => readGeneratedRegion(e.after, region));
    if (oldText.some((s, i) => s !== newText[i])) {
      if (oldText.some((s) => s !== null)) left.push(`${region} instructions`);
      if (newText.some((s) => s !== null)) entered.push(`${region} instructions`);
    }
  }
  return {
    module: name, state,
    changed: config !== original || instructions.length > 0 || synced.materialized.length > 0 || synced.pruned.length > 0 || synced.emitters.some((e) => e.written.length > 0 || e.removed.length > 0),
    context: { entered, left },
  };
}
