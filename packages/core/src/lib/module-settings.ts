import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, lstatSync } from "fs";
import { relative } from "path";
import { z } from "zod";
import type { BrainContext } from "./context.js";
import type { LoadedModule } from "./module-types.js";
import type { ModuleSettingsMigrationPlan } from "./module-settings-types.js";
import { isRecord, mergeModuleSettings, moduleSettingsPath, readModuleSettings } from "./module-settings-source.js";
import { equalSettings, rewriteSettingsJson } from "./module-settings-json.js";
import { safeResolve, writeFileSafely } from "./safe-path.js";
import { git, gitPath } from "./sync/git.js";

export class ModuleSettingsError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422 | 500, readonly errors: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "ModuleSettingsError";
  }
}

function moduleFor(brain: BrainContext, name: string): LoadedModule {
  const mod = brain.modules.find((m) => m.manifest.name === name);
  if (!mod?.declaration) throw new ModuleSettingsError(`Module "${name}" is unavailable`, 404);
  return mod;
}

function validate(mod: LoadedModule, values: unknown): unknown {
  try { return mod.declaration!.configSchema?.parse(values) ?? values; }
  catch (error) {
    const issues = error instanceof z.ZodError ? error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) : [{ path: "", message: (error as Error).message }];
    throw new ModuleSettingsError("Review the highlighted settings", 422, issues);
  }
}

function schemaFor(mod: LoadedModule): Record<string, unknown> {
  const schema = mod.declaration?.configSchema;
  if (!schema || !("_zod" in schema)) return {};
  // Input representation retains coercible legacy values; unknown/unrepresentable
  // leaves become read-only, while the original schema still validates saves.
  const result = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" });
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

function digest(parts: unknown[]): string {
  return '"' + createHash("sha256").update(JSON.stringify(parts)).digest("hex") + '"';
}

function currentSnapshot(brain: BrainContext, mod: LoadedModule) {
  const name = mod.manifest.name;
  const saved = readModuleSettings(brain.root, name);
  const schema = schemaFor(mod);
  function defaults(node: Record<string, unknown>, required = false): unknown {
    if (Object.hasOwn(node, "default")) return node.default;
    if (required && isRecord(node.properties)) return Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, isRecord(v) ? defaults(v, Array.isArray(node.required) && node.required.includes(k)) : undefined]).filter(([, v]) => v !== undefined));
    return undefined;
  }
  let inherited: unknown;
  try { inherited = validate(mod, mod.configInput ?? {}); }
  catch { inherited = mergeModuleSettings(defaults(schema, true) ?? {}, mod.configInput ?? {}); }
  const values = validate(mod, mergeModuleSettings(mod.configInput ?? {}, saved.values));
  const configSource = brain.configPath ? readFileSync(brain.configPath, "utf8") : null;
  if (brain.configSource !== undefined && configSource !== brain.configSource) throw new ModuleSettingsError("Brain config changed while reading settings; reload before saving", 409);
  const revision = digest([mod.key, configSource, saved.source]);
  const ui = mod.declaration?.settings;
  const migrationTarget = ui?.migration?.target;
  const lastSubject = git(brain.root, ["log", "-1", "--format=%s", "--", `settings/${name}.json`]).stdout;
  const migrated = migrationTarget && lastSubject === `brain: migrate ${name} settings`;
  const provenance: Record<string, "default" | "brain-config" | "saved" | "migrated"> = {};
  const inheritedProvenance: Record<string, "default" | "brain-config"> = {};
  function visit(value: unknown, path: string, base: unknown, override: unknown): void {
    if (path) {
      provenance[path] = override !== undefined ? migrated && (path === migrationTarget || path.startsWith(migrationTarget + ".")) ? "migrated" : "saved" : base !== undefined ? "brain-config" : "default";
      inheritedProvenance[path] = base !== undefined ? "brain-config" : "default";
    }
    if (isRecord(value)) for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, isRecord(base) ? base[key] : undefined, isRecord(override) ? override[key] : undefined);
    if (Array.isArray(value)) value.forEach((child, i) => visit(child, `${path}.${i}`, Array.isArray(base) ? base[i] : undefined, Array.isArray(override) ? override[i] : undefined));
  }
  visit(values, "", mod.configInput, saved.values);
  return {
    module: name, key: mod.key, state: mod.state ?? "active", canBeDormant: mod.manifest.canBeDormant ?? true,
    dormancyReason: mod.manifest.dormancyReason ?? null,
    schema, values, inherited, overrides: saved.values, provenance, inheritedProvenance, revision,
    notes: ui?.notes?.(values) ?? [],
    ui: { fields: ui?.fields ?? [], actions: ui?.actions ?? [], migration: ui?.migration ? { label: ui.migration.label, help: ui.migration.help ?? null, target: ui.migration.target ?? null } : null },
  };
}

/** Serialize CLI/HTTP settings transactions, including revision checks and commit. */
function withSettingsLock<T>(brain: BrainContext, run: () => T, readOnly = false): T {
  const directory = gitPath(brain.root, "brain-module-settings.lock");
  if (!directory) {
    if (readOnly) return run();
    throw new ModuleSettingsError("Settings require an initialized git repository", 500);
  }
  try { mkdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ModuleSettingsError("Another settings operation is running; retry after it finishes", 409);
    throw error;
  }
  try { return run(); }
  finally { rmSync(directory, { recursive: true }); }
}

export function getModuleSettings(brain: BrainContext, name: string): ReturnType<typeof currentSnapshot> {
  return withSettingsLock(brain, () => currentSnapshot(brain, moduleFor(brain, name)), true);
}

/** Validate a draft and compute module-owned notes without writing any state. */
export function previewModuleSettings(brain: BrainContext, name: string, overrides: unknown) {
  return withSettingsLock(brain, () => {
    const mod = moduleFor(brain, name);
    const snapshot = currentSnapshot(brain, mod);
    if (!isRecord(overrides) || Object.hasOwn(overrides, "enabled")) throw new ModuleSettingsError("Settings must be an object without module state", 422);
    const values = validate(mod, mergeModuleSettings(mod.configInput ?? {}, overrides));
    return { ...snapshot, values, overrides, notes: mod.declaration?.settings?.notes?.(values) ?? [] };
  }, true);
}

function commitChanges(brain: BrainContext, name: string, changes: Array<{ path: string; before: string | null; after: string }>, migration: boolean): { changed: boolean; commit: string | null } {
  const actual = changes.filter((c) => c.before !== c.after);
  if (!actual.length) return { changed: false, commit: null };
  if (git(brain.root, ["rev-parse", "--verify", "HEAD"]).code) throw new ModuleSettingsError("Commit the initial brain before saving module settings", 422);
  const paths = actual.map((c) => relative(safeResolve(brain.root, ".")!, c.path));
  for (const change of actual) {
    if (safeResolve(brain.root, change.path) !== change.path || lstatSync(change.path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ModuleSettingsError("A settings target is unsafe; no changes made", 422);
    const present = existsSync(change.path) ? readFileSync(change.path, "utf8") : null;
    if (present !== change.before) throw new ModuleSettingsError("Settings changed; review the saved values", 409);
  }
  // Never take somebody else's staged edits into this save or undo them on failure.
  const staged = git(brain.root, ["diff", "--cached", "--name-only", "--", ...paths]);
  if (staged.code || staged.stdout) throw new ModuleSettingsError("Commit the staged settings changes before saving", 409);
  let written = 0;
  try {
    for (const change of actual) { writeFileSafely(change.path, change.after); written++; }
    const add = git(brain.root, ["add", "--", ...paths]);
    if (add.code) throw new Error(add.stderr);
    const commit = git(brain.root, ["commit", "--only", "-m", `brain: ${migration ? "migrate" : "save"} ${name} settings`, "--", ...paths]);
    if (commit.code) throw new Error(commit.stderr || commit.stdout);
    return { changed: true, commit: git(brain.root, ["rev-parse", "HEAD"]).stdout };
  } catch (error) {
    for (const change of actual.slice(0, written).reverse()) {
      if (change.before === null) rmSync(change.path);
      else writeFileSafely(change.path, change.before);
    }
    // Only our target entries were staged; unrelated staged work stays intact.
    const reset = git(brain.root, ["reset", "--quiet", "HEAD", "--", ...paths]);
    if (reset.code) throw new ModuleSettingsError(`Save failed and index cleanup needs review: ${reset.stderr}`, 500);
    throw new ModuleSettingsError(`Save failed; no settings changed: ${(error as Error).message}`, 500);
  }
}

export function saveModuleSettings(brain: BrainContext, name: string, overrides: unknown, revision: string) {
  return withSettingsLock(brain, () => {
    const mod = moduleFor(brain, name);
    const snapshot = currentSnapshot(brain, mod);
    if (revision !== snapshot.revision) throw new ModuleSettingsError("Settings changed elsewhere; review both versions before saving", 409);
    if (!isRecord(overrides) || Object.hasOwn(overrides, "enabled")) throw new ModuleSettingsError("Settings must be an object; use the separate dormancy control for module state", 422);
    validate(mod, mergeModuleSettings(mod.configInput ?? {}, overrides));
    const path = moduleSettingsPath(brain.root, name);
    const before = readModuleSettings(brain.root, name).source;
    const outcome = commitChanges(brain, name, [{ path, before, after: rewriteSettingsJson(before, overrides) }], false);
    return { ...currentSnapshot(brain, mod), ...outcome };
  });
}

function migrationPlan(brain: BrainContext, mod: LoadedModule): ModuleSettingsMigrationPlan {
  const migration = mod.declaration?.settings?.migration;
  if (!migration) throw new ModuleSettingsError("This module has no migration", 404);
  let plan: ModuleSettingsMigrationPlan;
  try { plan = migration.plan(brain.root, mod.config); }
  catch (error) { throw new ModuleSettingsError((error as Error).message, 422); }
  for (const change of plan.changes) {
    if (!safeResolve(brain.root, change.path) || !equalSettings(change.before, readFileSync(safeResolve(brain.root, change.path)!, "utf8"))) throw new ModuleSettingsError("Migration source changed; preview again", 409);
  }
  return plan;
}

export function previewModuleSettingsMigration(brain: BrainContext, name: string) {
  return withSettingsLock(brain, () => {
    const mod = moduleFor(brain, name);
    const snapshot = currentSnapshot(brain, mod);
    const plan = migrationPlan(brain, mod);
    validate(mod, mergeModuleSettings(mod.configInput ?? {}, mergeModuleSettings(snapshot.overrides, plan.values)));
    return { ...plan.details, values: plan.values, revision: digest([snapshot.revision, plan.changes]), paths: plan.changes.map((c) => c.path) };
  });
}

export function migrateModuleSettings(brain: BrainContext, name: string, revision: string) {
  return withSettingsLock(brain, () => {
    const mod = moduleFor(brain, name);
    const snapshot = currentSnapshot(brain, mod);
    const plan = migrationPlan(brain, mod);
    if (revision !== digest([snapshot.revision, plan.changes])) throw new ModuleSettingsError("Migration preview is stale; preview again", 409);
    const overrides = mergeModuleSettings(snapshot.overrides, plan.values);
    if (!isRecord(overrides)) throw new ModuleSettingsError("Invalid migration values", 422);
    validate(mod, mergeModuleSettings(mod.configInput ?? {}, overrides));
    const path = moduleSettingsPath(brain.root, name);
    const outcome = commitChanges(brain, name, [
      { path, before: readModuleSettings(brain.root, name).source, after: rewriteSettingsJson(readModuleSettings(brain.root, name).source, overrides) },
      ...plan.changes.map((c) => ({ ...c, path: safeResolve(brain.root, c.path)! })),
    ], true);
    return { ...currentSnapshot(brain, mod), ...outcome };
  });
}
