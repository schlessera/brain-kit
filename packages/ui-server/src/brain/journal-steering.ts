/** Data-only inventory of known steering surfaces and retained local references. */
import { posix } from "node:path";
import type { JournalSnapshot, JournalSnapshotEntry } from "./journal-snapshot.js";

const instructions = /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SYSTEM|APPEND_SYSTEM)\.md$/;
const configuration = /(?:^|\/)(?:brain\.config\.(?:ts|json)|bunfig\.toml|package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.mcp\.json)$/;
const surfaces = /(?:^|\/)(?:\.claude|\.agents|\.pi)\//;
const schedules = /(?:^|\/)context\/scheduled-tasks\//;
const policy = /(?:^|\/)context\/policies(?:\/|$)/;
const scripts = /\.(?:[cm]?[jt]sx?|json|toml|ya?ml)$/;

/** A classification inventory, never a claim that arbitrary code was executed. */
export function journalSteeringInputs(snapshots: readonly JournalSnapshot[], read: (hash: string, maximum: number) => Buffer) {
  const entries = new Map<string, JournalSnapshotEntry>();
  const paths = new Set<string>(), pending: JournalSnapshotEntry[] = [];
  const unavailable = new Set<string>();
  for (const snapshot of snapshots) for (const entry of snapshot.entries) {
    entries.set(entry.path, entry);
    if (!policy.test(entry.path) && (instructions.test(entry.path) || configuration.test(entry.path) || surfaces.test(entry.path) || schedules.test(entry.path))) {
      paths.add(entry.path); pending.push(entry);
    }
  }
  const visited = new Set<string>();
  const add = (from: JournalSnapshotEntry, reference: string) => {
    if (!reference || reference.startsWith("/") || reference.includes(":") || reference.includes("\0")) return;
    const candidate = posix.normalize(posix.join(posix.dirname(from.path), reference));
    const rootRelative = posix.normalize(posix.join(from.scope, reference));
    for (const path of [candidate, rootRelative]) for (const suffix of ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.js"]) {
      const resolved = `${path}${suffix}`, entry = entries.get(resolved);
      if (!entry || policy.test(resolved) || entry.scope !== from.scope || paths.has(resolved)) continue;
      paths.add(resolved); pending.push(entry);
    }
  };
  while (pending.length) {
    const entry = pending.pop()!;
    if (!scripts.test(entry.path) || visited.has(`${entry.path}:${entry.hash}`)) continue;
    visited.add(`${entry.path}:${entry.hash}`);
    // Classification reads only the existing retained object, never the live
    // path or an import. Large/ignored/opaque inputs stay explicitly unknown.
    if (!entry.hash || entry.bytes > 1024 * 1024) { unavailable.add(entry.path); continue; }
    let text: string;
    try { text = read(entry.hash, 1024 * 1024).toString("utf8"); } catch { unavailable.add(entry.path); continue; }
    if (/\.[cm]?[jt]sx?$/.test(entry.path)) {
      try {
        const loader = entry.path.endsWith("x") ? "tsx" : "ts";
        for (const reference of new Bun.Transpiler({ loader }).scan(text).imports) if (reference.path.startsWith(".")) add(entry, reference.path);
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
