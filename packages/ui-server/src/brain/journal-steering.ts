/** Data-only inventory of known steering surfaces and retained local references. */
import { posix } from "node:path";
import type { JournalSnapshot, JournalSnapshotEntry } from "./journal-snapshot.js";

const instructions = /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SYSTEM|APPEND_SYSTEM)\.md$/;
// Startup consumers run at the canonical brain cwd, not every workspace:
// core loadUserConfig, Bun startup/module resolution, Claude project MCP.
// Lockfiles are package-manager inputs, not unconditional runtime inputs.
const startupConfiguration = /^(?:brain\.config\.(?:ts|json)|bunfig\.toml|package\.json|\.mcp\.json)$/;
const surfaces = /(?:^|\/)(?:\.claude|\.agents|\.pi)\//;
const schedules = /(?:^|\/)context\/scheduled-tasks\//;
const policy = /(?:^|\/)context\/policies(?:\/|$)/;
const scripts = /\.(?:[cm]?[jt]sx?|json|toml|ya?ml)$/;

export const isJournalSteeringPath = (path: string): boolean => !policy.test(path) &&
  (instructions.test(path) || startupConfiguration.test(path) || surfaces.test(path) || schedules.test(path));

/** A classification inventory, never a claim that arbitrary code was executed. */
function* steeringInventory(snapshots: readonly JournalSnapshot[], lookup?: (path: string) => JournalSnapshotEntry | undefined): Generator<JournalSnapshotEntry, { paths: Set<string>; unavailable: string[] }, Buffer | undefined> {
  const entries = new Map<string, JournalSnapshotEntry>();
  const paths = new Set<string>(), pending: JournalSnapshotEntry[] = [];
  const unavailable = new Set<string>();
  for (const snapshot of snapshots) for (const entry of snapshot.entries) {
    entries.set(entry.path, entry);
    if (isJournalSteeringPath(entry.path)) {
      paths.add(entry.path); pending.push(entry);
    }
  }
  const visited = new Set<string>();
  const moduleManifests = new Set<string>();
  const packageScope = (entry: JournalSnapshotEntry) => {
    // Bun's Node-compatible package scope lookup for a genuinely reached module.
    // Stop at this journal scope; never promote sibling clones/dependencies.
    let directory = posix.dirname(entry.path);
    for (;;) {
      const name = posix.join(directory, "package.json");
      const manifest = entries.get(name) ?? lookup?.(name);
      if (manifest && manifest.scope === entry.scope) {
        if (!paths.has(name)) { paths.add(name); moduleManifests.add(name); pending.push(manifest); }
        return;
      }
      if (directory === (entry.scope || ".")) return;
      const parent = posix.dirname(directory);
      if (parent === directory || (entry.scope && !parent.startsWith(entry.scope))) return;
      directory = parent;
    }
  };
  const add = (from: JournalSnapshotEntry, reference: string, module = false) => {
    if (!reference || reference.startsWith("/") || reference.includes(":") || reference.includes("\0")) return;
    const candidate = posix.normalize(posix.join(posix.dirname(from.path), reference));
    const rootRelative = posix.normalize(posix.join(from.scope, reference));
    for (const path of [candidate, rootRelative]) for (const suffix of ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.js"]) {
      const resolved = `${path}${suffix}`, entry = entries.get(resolved) ?? lookup?.(resolved);
      if (!entry || policy.test(resolved) || entry.scope !== from.scope) continue;
      if (module && /\.[cm]?[jt]sx?$/.test(entry.path)) packageScope(entry);
      if (!paths.has(resolved)) { paths.add(resolved); pending.push(entry); }
    }
  };
  while (pending.length) {
    const entry = pending.pop()!;
    if (!scripts.test(entry.path) || visited.has(`${entry.path}:${entry.hash ?? entry.stamp}`)) continue;
    visited.add(`${entry.path}:${entry.hash ?? entry.stamp}`);
    // Readers use retained objects or pinned sealed roots, never live imports.
    if (entry.ignored || entry.bytes > 1024 * 1024) { unavailable.add(entry.path); continue; }
    const bytes = yield entry;
    if (!bytes) { unavailable.add(entry.path); continue; }
    const text = bytes.toString("utf8");
    // Package-scope metadata controls module resolution. Its scripts are not
    // thereby executed; script declarations never discover additional consumers.
    if (moduleManifests.has(entry.path)) {
      try {
        const manifest = JSON.parse(text);
        // Conditional exports/import maps and package discovery are not resolved
        // by this finite local-file walker; retain a source-specific limitation.
        if (manifest.imports !== undefined || manifest.exports !== undefined) unavailable.add(entry.path);
      } catch { unavailable.add(entry.path); }
      continue;
    }
    if (entry.path === "bunfig.toml") {
      try {
        const config = Bun.TOML.parse(text);
        if (Array.isArray(config.preload)) for (const path of config.preload) if (typeof path === "string") add(entry, path, true);
      } catch { unavailable.add(entry.path); }
    }
    if (/\.[cm]?[jt]sx?$/.test(entry.path)) {
      try {
        const loader = entry.path.endsWith("x") ? "tsx" : "ts";
        for (const reference of new Bun.Transpiler({ loader }).scan(text).imports) if (reference.path.startsWith(".")) add(entry, reference.path, true);
      } catch { unavailable.add(entry.path); }
      // Computed imports/resources cannot be identified by a data-only reader.
      for (const call of text.matchAll(/\b(?:import|require|readFile(?:Sync)?)\s*\(([^)]*)\)/g)) {
        if (!/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*(?:,|$)/.test(call[1]!.trim())) unavailable.add(entry.path);
      }
    }
    // Literal local resources, settings paths, preload names and hook command
    // arguments from the audited startup consumers. Resolve only names already
    // in this same journal scope; no shell/config execution or path following.
    for (const match of text.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const value = match[1]!;
      if (!value.includes(" ")) add(entry, value);
      else for (const word of value.split(/\s+/)) if (word.startsWith(".") || word.includes("/")) add(entry, word);
    }
  }
  return { paths, unavailable: [...unavailable].sort() };
}

/** Existing retained-object reader, also used by historical journal fixtures. */
export function journalSteeringInputs(snapshots: readonly JournalSnapshot[], read: (hash: string, maximum: number) => Buffer) {
  const inventory = steeringInventory(snapshots);
  let step = inventory.next();
  while (!step.done) {
    let bytes: Buffer | undefined;
    try { if (step.value.hash) bytes = read(step.value.hash, 1024 * 1024); } catch { /* Explicit unavailable classification. */ }
    step = inventory.next(bytes);
  }
  return step.value;
}

/** Native admission needs no CAS copy of unchanged configuration inputs. */
export async function nativeJournalSteeringInputs(snapshots: readonly JournalSnapshot[], read: (entry: JournalSnapshotEntry, maximum: number) => Promise<Buffer>, lookup?: (path: string) => JournalSnapshotEntry | undefined) {
  const inventory = steeringInventory(snapshots, lookup);
  let step = inventory.next();
  while (!step.done) {
    let bytes: Buffer | undefined;
    try { bytes = await read(step.value, 1024 * 1024); } catch { /* Explicit unavailable classification. */ }
    step = inventory.next(bytes);
  }
  return step.value;
}
