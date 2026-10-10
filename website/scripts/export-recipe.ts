import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const repository = resolve(import.meta.dir, '../..');
export async function exportRecipeHash() {
  const files = ['website/src/demo/app.tsx', 'website/src/demo/file-worker.ts', 'website/src/components/DemoFrame.astro', 'website/src/demo/odyssey.ts', 'website/src/demo/export-key.ts', 'website/scripts/generate-shares.ts', 'website/scripts/export-recipe.ts', 'website/scripts/build.ts', 'website/scripts/png-metadata.ts', 'website/scripts/generate-previews.ts', 'scripts/captures/font-lock.json', 'scripts/captures/fonts.css', 'bun.lock'];
  for (const directory of ['packages/ui-react/src', 'packages/ui-sdk/src', 'packages/ui-kit/src', 'packages/ui-kit/fixtures', 'packages/render-template/src', 'packages/ui-render-puppeteer/src']) {
    for await (const file of new Bun.Glob('**/*.{ts,tsx,css,json}').scan(resolve(repository, directory))) files.push(`${directory}/${file}`);
  }
  const hash = createHash('sha256');
  for (const path of files.sort()) { hash.update(path); hash.update(new Uint8Array(await Bun.file(resolve(repository, path)).arrayBuffer())); }
  return hash.digest('hex');
}
