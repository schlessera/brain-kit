import { createStore } from "zustand/vanilla";
import type { ConfiguredModule, ModuleSettingsSnapshot, ModuleSettingsMigrationPreview } from "@schlessera/brain-ui-sdk";

export type SettingsPath = Array<string | number>;
export interface VariantSelection { selected: string; original: string; keys: string[]; originallyPresent: string[] }
export interface ModuleSettingsSession {
  modules: ConfiguredModule[];
  loading: boolean;
  error: string | null;
  name: string | null;
  snapshot: ModuleSettingsSnapshot | null;
  draft: Record<string, unknown>;
  variants: Record<string, VariantSelection>;
  localErrors: Record<string, string>;
  errors: Array<{ path: string; message: string }>;
  busy: string | null;
  message: string | null;
  leave: (() => void) | null;
  conflict: ModuleSettingsSnapshot | null;
  choices: Record<string, "yours" | "saved">;
  preview: ModuleSettingsMigrationPreview | null;
  confirm: string | null;
  generation: number;
  draftNotes: Array<{ key: string; text: string }> | null;
  pendingInputs: Record<string, string>;
}

export function createModuleSettingsSession() {
  return createStore<ModuleSettingsSession>(() => ({ modules: [], loading: false, error: null, name: null, snapshot: null, draft: {}, variants: {}, localErrors: {}, errors: [], busy: null, message: null, leave: null, conflict: null, choices: {}, preview: null, confirm: null, generation: 0, draftNotes: null, pendingInputs: {} }));
}
export type ModuleSettingsSessionStore = ReturnType<typeof createModuleSettingsSession>;

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function mergeSettings(base: unknown, overrides: unknown): unknown {
  if (!record(base) || !record(overrides)) return overrides;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overrides)])].map((k) => [k, Object.hasOwn(overrides, k) ? Object.hasOwn(base, k) ? mergeSettings(base[k], overrides[k]) : overrides[k] : base[k]]));
}
export function sameSettings(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameSettings(v, b[i]));
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && sameSettings(a[k], b[k]));
  return false;
}
export function valueAt(value: unknown, path: SettingsPath): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
export function replaceAt(value: unknown, path: SettingsPath, next: unknown, remove = false): unknown {
  if (!path.length) return next;
  const [key, ...tail] = path;
  if (Array.isArray(value)) return value.map((v, i) => i === Number(key) ? replaceAt(v, tail, next, remove) : v);
  const entries = Object.entries(record(value) ? value : {}).filter(([k]) => !(remove && !tail.length && k === key));
  if (!(remove && !tail.length)) {
    const child = replaceAt(valueAt(value, [key!]), tail, next, remove);
    const at = entries.findIndex(([k]) => k === key);
    if (at >= 0) entries[at] = [String(key), child];
    else entries.push([String(key), child]);
  }
  const result = Object.fromEntries(entries);
  // Resetting a leaf must not leave an empty override that materializes defaults.
  if (remove) for (const [k, child] of Object.entries(result)) if (record(child) && !Object.keys(child).length) delete result[k];
  return result;
}
export function savedDraft(session: Pick<ModuleSettingsSession, "draft" | "variants">): Record<string, unknown> {
  let result = session.draft;
  for (const [path, variant] of Object.entries(session.variants)) {
    const keys = variant.selected === variant.original ? variant.keys.filter((k) => !variant.originallyPresent.includes(k)) : variant.keys.filter((k) => k !== variant.selected);
    for (const key of keys) result = replaceAt(result, [...path.split(".").filter(Boolean).map((k) => /^\d+$/.test(k) ? Number(k) : k), key], undefined, true) as Record<string, unknown>;
  }
  return result;
}
export function settingsDirty(session: ModuleSettingsSession): boolean {
  return session.snapshot !== null && (!sameSettings(savedDraft(session), session.snapshot.overrides) || Object.values(session.pendingInputs).some(Boolean) || Object.keys(session.localErrors).length > 0 || Object.values(session.variants).some((v) => v.selected !== v.original));
}

/** Explicitly review every changed leaf; arrays are reviewed as complete ordered values. */
export function changedSettingsPaths(a: unknown, b: unknown, prefix: SettingsPath = []): SettingsPath[] {
  if (sameSettings(a, b)) return [];
  if (record(a) && record(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => changedSettingsPaths(a[key], b[key], [...prefix, key]));
  return [prefix];
}
