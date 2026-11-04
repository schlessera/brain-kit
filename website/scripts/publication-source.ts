import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';

export const snapshotName = '.website-source.json';
// Only build outputs may change in the isolated publication workspace. The
// product build adds its lease and a per-build receipt under tmp/
// (scripts/workspace-lease.mjs, scripts/build-receipt.ts); website/scripts/build.ts
// writes the demo bundle, its transport, its library file and its HTML route.
const generated = [snapshotName, '**/node_modules/**', '**/dist/**', '**/.astro/**', '**/.git/**', 'website/.impeccable/review/**', 'website/test-results/**', 'website/public/assets/demo/**', 'website/public/assets/shares/**', 'website/public/assets/previews/**', 'website/public/assets/product.css', 'website/public/assets/fonts.css', 'website/public/demo/transport.js', 'website/public/demo/library.json', 'website/public/demo/api/**', 'tmp/workspace-operation/**', 'tmp/build-*-probe.json', 'tmp/build-*-probe.json.writing'];
async function sourceInputPaths(root: string) {
  const paths: string[] = [];
  async function walk(directory = '') {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (['node_modules', 'dist', '.astro', '.git'].includes(entry.name) || generated.some(pattern => new Bun.Glob(pattern).match(path))) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await walk();
  return paths.sort();
}
export async function sourceInputHash(root: string) {
  const hash = createHash('sha256');
  for (const path of await sourceInputPaths(root)) { hash.update(path); hash.update('\0'); hash.update(new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer())); }
  return hash.digest('hex');
}
// Per-file digests let a changed input be named instead of only detected.
export async function sourceInputDigests(root: string) {
  const digests: Record<string, string> = {};
  for (const path of await sourceInputPaths(root)) digests[path] = createHash('sha256').update(new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer())).digest('hex');
  return digests;
}
export function describeInputChanges(before: Record<string, string> | undefined, after: Record<string, string>) {
  if (!before) return '';
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(path => !(path in after) ? [`removed ${path}`] : !(path in before) ? [`added ${path}`] : before[path] !== after[path] ? [`modified ${path}`] : []);
  return changed.length ? `: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ` and ${changed.length - 20} more` : ''}` : '';
}
