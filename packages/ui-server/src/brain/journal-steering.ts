/** Data-only inventory of known steering surfaces and retained local references. */
import { steeringReferences, type SteeringReference } from "./journal-reference-roles.js";
import { posix } from "node:path";
import type { JournalSnapshot, JournalSnapshotEntry } from "./journal-snapshot.js";

const instructions = /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SYSTEM|APPEND_SYSTEM)\.md$/;
const configuration = /(?:^|\/)(?:brain\.config\.(?:ts|json)|bunfig\.toml|package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.mcp\.json)$/;
const surfaces = /(?:^|\/)(?:\.claude|\.agents|\.pi)\//;
const schedules = /(?:^|\/)context\/scheduled-tasks\//;
const policy = /(?:^|\/)context\/policies(?:\/|$)/;
const scripts = /\.(?:[cm]?[jt]sx?|json|toml|ya?ml|sh|bash)$/;

/** Trusted journal-relative identities, never values inferred from repository text. */
export interface JournalSteeringOptions { resolvedIndexPaths?: readonly string[] }

export const isJournalSteeringPath = (path: string): boolean => !policy.test(path) &&
  (instructions.test(path) || configuration.test(path) || surfaces.test(path) || schedules.test(path));

/** A classification inventory, never a claim that arbitrary code was executed. */
function* steeringInventory(snapshots: readonly JournalSnapshot[], lookup?: (path: string) => JournalSnapshotEntry | undefined, options: JournalSteeringOptions = {}): Generator<JournalSnapshotEntry, { paths: Set<string>; unavailable: string[] }, Buffer | undefined> {
  const entries = new Map<string, JournalSnapshotEntry>();
  const paths = new Set<string>(), pending: { entry: JournalSnapshotEntry; instructionDepth?: number; configuration?: boolean }[] = [];
  const unavailable = new Set<string>();
  for (const snapshot of snapshots) for (const entry of snapshot.entries) {
    entries.set(entry.path, entry);
    if (isJournalSteeringPath(entry.path)) {
      paths.add(entry.path); pending.push({entry, configuration: true, instructionDepth: /(?:^|\/)(?:CLAUDE|AGENTS)(?:\.local)?\.md$/.test(entry.path) ? 0 : undefined});
    }
  }
  // Core initContext fixes its index at <root>/brain.db. Explicit identities
  // support callers that already resolved a different index; this is no new
  // repository configuration format. Sidecars derive from that exact identity.
  const indexes = options.resolvedIndexPaths ?? [...new Set([...entries.values()].map(entry => posix.join(entry.scope, "brain.db")))];
  const disposable = new Set(indexes.flatMap(path => ["", "-wal", "-shm", "-journal"].map(suffix => `${posix.normalize(path)}${suffix}`)));
  for (const path of disposable) paths.delete(path);
  const visited = new Set<string>();
  const add = (from: JournalSnapshotEntry, reference: SteeringReference) => {
    const value = reference.path;
    if (!value || value.startsWith("/") || value.includes(":") || value.includes("\\") || value.includes("\0")) { unavailable.add(from.path); return; }
    const base = reference.base === "file" ? posix.dirname(from.path) : from.scope;
    const candidate = posix.normalize(posix.join(base, value));
    // Bun's documented relative module order, verified with a keyless resolver
    // fixture. This runs only after an input role is established, never as a
    // filename/extension classifier. Package/directory config stays unknown.
    const extensions = [".tsx", ".jsx", ".mts", ".ts", ".mjs", ".js", ".cts", ".cjs", ".json"];
    const candidates = reference.manifest ? [`${candidate}.ts`, `${candidate}.js`] : reference.module
      ? [candidate, ...(/\.jsx?$/.test(candidate) ? [candidate.replace(/\.jsx?$/, ".ts"), candidate.replace(/\.jsx?$/, ".tsx")] : /\.mjs$/.test(candidate) ? [candidate.replace(/\.mjs$/, ".mts")] : []),
        ...(!posix.extname(candidate) ? [...extensions.map(suffix => `${candidate}${suffix}`), ...extensions.map(suffix => `${candidate}/index${suffix}`)] : [])] : [candidate];
    for (const resolved of candidates) {
      // Scope checks precede lookup, including the canonical root/workspaces
      // distinction. Readers never receive a traversal/out-of-scope candidate.
      if (resolved.startsWith("../") || resolved === ".." || (from.scope ? !resolved.startsWith(`${from.scope}/`) : resolved.startsWith("workspaces/"))) continue;
      if (policy.test(resolved) || disposable.has(resolved)) return;
      const entry = entries.get(resolved) ?? lookup?.(resolved);
      if (!entry || entry.scope !== from.scope) continue;
      if (!paths.has(resolved) || reference.instructionDepth !== undefined) { paths.add(resolved); pending.push({entry, instructionDepth:reference.instructionDepth}); }
      return;
    }
    unavailable.add(from.path);
  };
  while (pending.length) {
    const { entry, instructionDepth, configuration } = pending.pop()!;
    if (disposable.has(entry.path) || visited.has(`${entry.path}:${entry.hash ?? entry.stamp}:${instructionDepth ?? "module"}:${configuration ?? false}`)) continue;
    visited.add(`${entry.path}:${entry.hash ?? entry.stamp}:${instructionDepth ?? "module"}:${configuration ?? false}`);
    // Readers use retained objects or pinned sealed roots, never live imports.
    if (entry.kind !== "file" || entry.ignored || entry.bytes > 1024 * 1024) { unavailable.add(entry.path); continue; }
    if (instructionDepth === undefined && !scripts.test(entry.path)) continue;
    const bytes = yield entry;
    if (!bytes) { unavailable.add(entry.path); continue; }
    const text = bytes.toString("utf8");
    const roles = steeringReferences(entry.path, text, instructionDepth, configuration);
    if (roles.unknown) unavailable.add(entry.path);
    for (const reference of roles.references) add(entry, reference);
  }
  return { paths, unavailable: [...unavailable].sort() };
}

/** Existing retained-object reader, also used by historical journal fixtures. */
export function journalSteeringInputs(snapshots: readonly JournalSnapshot[], read: (hash: string, maximum: number) => Buffer, options: JournalSteeringOptions = {}) {
  const inventory = steeringInventory(snapshots, undefined, options);
  let step = inventory.next();
  while (!step.done) {
    let bytes: Buffer | undefined;
    try { if (step.value.hash) bytes = read(step.value.hash, 1024 * 1024); } catch { /* Explicit unavailable classification. */ }
    step = inventory.next(bytes);
  }
  return step.value;
}

/** Native admission needs no CAS copy of unchanged configuration inputs. */
export async function nativeJournalSteeringInputs(snapshots: readonly JournalSnapshot[], read: (entry: JournalSnapshotEntry, maximum: number) => Promise<Buffer>, lookup?: (path: string) => JournalSnapshotEntry | undefined, options: JournalSteeringOptions = {}) {
  const inventory = steeringInventory(snapshots, lookup, options);
  let step = inventory.next();
  while (!step.done) {
    let bytes: Buffer | undefined;
    try { bytes = await read(step.value, 1024 * 1024); } catch { /* Explicit unavailable classification. */ }
    step = inventory.next(bytes);
  }
  return step.value;
}
