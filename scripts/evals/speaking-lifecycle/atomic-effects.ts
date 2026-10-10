/** Private #1450 effect rule. Expectations precede observation; snapshots remain raw. */
import { dirname } from "node:path";
import type { observe } from "./full-observer";
type Tree = ReturnType<typeof observe>;
export type ExpectedReplacements = Record<string, { bytes: string; mode: number }>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Only verified, performed replacements can license their exact parent's timestamp. */
export function verifiedAtomicParents(before: Tree, after: Tree, expected: ExpectedReplacements) {
  const parents = new Set<string>();
  for (const [path, replacement] of Object.entries(expected)) {
    const prior = before[path], next = after[path];
    if (prior?.kind !== "file" || next?.kind !== "file" || prior.mode !== replacement.mode ||
      next.mode !== replacement.mode || next.bytes !== replacement.bytes || prior.bytes === next.bytes) continue;
    const parent = dirname(path), prefix = parent + "/";
    // Renaming a temporary file may change mtime, but may not leave any new/missing member.
    const members = (tree: Tree) => Object.keys(tree).filter(p => p.startsWith(prefix)).sort();
    if (same(members(before), members(after))) parents.add(parent);
  }
  return parents;
}
export function parentTimestampOnly(path: string, before: Tree, after: Tree, parents: Set<string>) {
  const prior = before[path], next = after[path];
  if (!parents.has(path) || prior?.kind !== "directory" || next?.kind !== "directory") return false;
  const { mtimeNs: priorTime, ...priorMetadata } = prior;
  const { mtimeNs: nextTime, ...nextMetadata } = next;
  return priorTime !== nextTime && same(priorMetadata, nextMetadata);
}
/** The archive contract has independent expected source bytes, including preserved prose. */
export function expectedArchives(before: Tree, paths: string[]): ExpectedReplacements {
  return Object.fromEntries(paths.map(path => {
    const entry = before[path];
    if (entry?.kind !== "file" || !entry.bytes) throw Error(`Archive target is not an existing source: ${path}`);
    const raw = Buffer.from(entry.bytes, "base64").toString("utf8");
    const expected = raw.replace("status: active", "status: archived").replace("relevance: primary", "relevance: historical");
    if (raw === expected) throw Error(`Archive control requires an actual replacement: ${path}`);
    return [path, { bytes: Buffer.from(expected).toString("base64"), mode: entry.mode }];
  }));
}
/** Full union detects added members too; disposable CLI cache paths remain explicit. */
export function archiveEffects(before: Tree, after: Tree, expected: ExpectedReplacements, cache = false) {
  const parents = verifiedAtomicParents(before, after, expected), violations: string[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const prior = before[path], next = after[path], replacement = expected[path];
    if (replacement) {
      if (next?.kind !== "file" || next.bytes !== replacement.bytes || next.mode !== replacement.mode)
        violations.push(`source bytes/mode:${path}`);
    } else if (!same(prior, next) && !(cache && /^brain\.db(?:-wal|-shm)?$/.test(path)) &&
      !parentTimestampOnly(path, before, after, parents)) violations.push(`unexpected effect:${path}`);
  }
  return violations;
}
