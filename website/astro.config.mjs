import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import { base, site, repositoryLinks } from './model.mjs';
import { markExternalLinks } from './external-links.mjs';

export default defineConfig({
  output: 'static', site, base, trailingSlash: 'always',
  cacheDir: './.astro/cache/',
  markdown: { processor: unified({ remarkPlugins: [repositoryLinks], rehypePlugins: [markExternalLinks] }) },
  vite: { server: { fs: { allow: ['..'] } } },
});
