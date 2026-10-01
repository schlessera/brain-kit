import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { safeResolve } from "./safe-path.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Objects merge by own key; arrays and scalar values replace, including null. */
export function mergeModuleSettings(base: unknown, overrides: unknown): unknown {
  if (!isRecord(base) || !isRecord(overrides)) return overrides;
  if (!Object.keys(overrides).length) return base;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overrides)])].map((key) => [key,
    Object.hasOwn(overrides, key)
      ? Object.hasOwn(base, key) ? mergeModuleSettings(base[key], overrides[key]) : overrides[key]
      : base[key],
  ]));
}

/** CLI leaf edits retain whole source arrays, without copying object defaults. */
export function setModuleSetting(overrides: unknown, effective: unknown, path: string[], value: unknown): unknown {
  if (!path.length) return value;
  const [key, ...tail] = path;
  if (Array.isArray(effective)) {
    if (!/^\d+$/.test(key!)) throw new Error("Array settings need a numeric index");
    const index = Number(key);
    const array = Array.isArray(overrides) ? [...overrides] : structuredClone(effective);
    if (index > array.length) throw new Error("Settings array index is out of range");
    array[index] = setModuleSetting(array[index], effective[index], tail, value);
    return array;
  }
  const entries = Object.entries(isRecord(overrides) ? overrides : {});
  const child = setModuleSetting(isRecord(overrides) ? overrides[key!] : undefined, isRecord(effective) ? effective[key!] : undefined, tail, value);
  const at = entries.findIndex(([name]) => name === key);
  if (at >= 0) entries[at] = [key!, child]; else entries.push([key!, child]);
  return Object.fromEntries(entries);
}

export function moduleSettingsPath(root: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`Module "${name}" cannot use settings: a lowercase module name is required`);
  const path = safeResolve(root, `settings/${name}.json`);
  if (!path) throw new Error(`Settings for module "${name}" resolve outside the brain root`);
  const canonicalRoot = safeResolve(root, ".")!;
  if (path !== resolve(canonicalRoot, "settings", `${name}.json`)) throw new Error(`Settings for module "${name}" must use their own file, without symlink aliases`);
  return path;
}

export function readModuleSettings(root: string, name: string): { source: string | null; values: Record<string, unknown> } {
  const path = moduleSettingsPath(root, name);
  if (!existsSync(path)) return { source: null, values: {} };
  const source = readFileSync(path, "utf8");
  let values: unknown;
  try { values = JSON.parse(source); }
  catch (error) { throw new Error(`Invalid settings/${name}.json: ${(error as Error).message}`); }
  if (!isRecord(values)) throw new Error(`Invalid settings/${name}.json: expected a JSON object`);
  if (Object.hasOwn(values, "enabled")) throw new Error(`Invalid settings/${name}.json: enabled belongs to the separate module enable/disable command`);
  return { source, values };
}
