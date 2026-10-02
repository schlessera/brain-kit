import { fileURLToPath } from 'node:url';
import { resolve, relative, posix } from 'node:path';
import { existsSync, statSync } from 'node:fs';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const base = process.env.SITE_SPIKE_BASE || '/brain-kit/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('Base must be a slash-delimited path');
export const sourceRoot = 'https://github.com/schlessera/brain-kit';
export const routes = {
  'docs/README.md': 'docs',
  'docs/quickstart.md': 'docs/quickstart',
  'docs/concepts.md': 'docs/concepts',
  'docs/configuration.md': 'docs/configuration',
  'docs/cli.md': 'docs/cli',
  'docs/hosting/README.md': 'docs/hosting',
  'docs/extending/README.md': 'docs/extending',
  'scripts/site-model-spike/sample/nested/links.md': 'experiment/nested/links',
};
export const assets = {
  'scripts/site-model-spike/sample/media/route.svg': 'assets/experiment-route.svg',
};
export const sourceUrl = (path, kind = 'blob') => `${sourceRoot}/${kind}/main/${path.split('/').map(encodeURIComponent).join('/')}`;

// This experiment tests one concrete transformation, not a publishing seam.
export function repositoryLinks() {
  return (tree, file) => {
    const source = relative(repositoryRoot, file.path).split('\\').join('/');
    const walk = (node) => {
      if (['link', 'image', 'definition'].includes(node.type) && node.url) {
        const original = node.url;
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(original)) {
          const [, path, suffix = ''] = original.match(/^([^?#]*)(.*)$/);
          const target = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(source), decodeURIComponent(path)));
          if (target.startsWith('../')) throw new Error(`Link leaves repository: ${original}`);
          const actual = resolve(repositoryRoot, target);
          if (!existsSync(actual)) throw new Error(`Missing repository link: ${source} -> ${original}`);
          if (routes[target]) node.url = `${base}${routes[target]}/${suffix}`;
          else if (assets[target]) node.url = `${base}${assets[target]}${suffix}`;
          else if (node.type === 'image') throw new Error(`Unmapped experiment image: ${target}`);
          else node.url = sourceUrl(target, statSync(actual).isDirectory() ? 'tree' : 'blob') + suffix;
        }
      }
      for (const child of node.children || []) walk(child);
    };
    walk(tree);
  };
}
