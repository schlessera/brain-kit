import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assets, base, repositoryLinks, repositoryRoot } from './model.mjs';

for (const [source, destination] of Object.entries(assets)) {
  const output = resolve('dist/public', destination);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(resolve(repositoryRoot, source), output);
}
export default defineConfig({
  output: 'static',
  base,
  trailingSlash: 'always',
  publicDir: './dist/public/',
  outDir: './dist/site/',
  cacheDir: './dist/cache/',
  markdown: { processor: unified({ remarkPlugins: [repositoryLinks] }) },
});
