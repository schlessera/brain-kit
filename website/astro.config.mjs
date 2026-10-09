import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import { base, site, repositoryLinks } from './model.mjs';

export default defineConfig({
  output: 'static', site, base, trailingSlash: 'always',
  cacheDir: './.astro/cache/',
  markdown: { processor: unified({ remarkPlugins: [repositoryLinks] }) },
  vite: { server: { fs: { allow: ['..'] } } },
});
