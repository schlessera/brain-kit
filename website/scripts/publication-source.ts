import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';

export const snapshotName = '.website-source.json';
// Only build outputs may change in the isolated publication workspace.
const generated = [snapshotName, '**/node_modules/**', '**/dist/**', '**/.astro/**', '**/.git/**', 'website/.impeccable/review/**', 'website/test-results/**', 'website/public/assets/demo/**', 'website/public/assets/shares/**', 'website/public/assets/previews/**', 'website/public/assets/product.css', 'website/public/assets/fonts.css', 'website/public/demo/transport.js', 'website/public/demo/api/**'];
export async function sourceInputHash(root: string) {
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
  const hash = createHash('sha256');
  for (const path of paths.sort()) { hash.update(path); hash.update('\0'); hash.update(new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer())); }
  return hash.digest('hex');
}
