import { resolve, posix } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';

// Astro bundles this module into dist/.prerender, so import.meta.url cannot
// locate the source tree there. Builds run in website/; checks run at the root.
export const publicationRoot = process.env.WEBSITE_CONTENT_ROOT || (existsSync(resolve(process.cwd(), 'docs/README.md')) ? process.cwd() : resolve(process.cwd(), '..'));
// Publication is an editorial choice. Repository references never expand this
// list: the engineering archive has a different audience from the handbook.
export const publications = Object.freeze({
  "docs/handbook/README.md": "docs",
  "docs/handbook/concepts.md": "docs/concepts",
  "docs/handbook/quickstart.md": "docs/quickstart",
  "docs/handbook/daily-workflow.md": "docs/daily-workflow",
  "docs/handbook/organizing.md": "docs/organizing",
  "docs/handbook/agents.md": "docs/agents",
  "docs/handbook/interface.md": "docs/interface",
  "docs/handbook/search.md": "docs/search",
  "docs/handbook/configuration.md": "docs/configuration",
  "docs/handbook/modules.md": "docs/modules",
  "docs/handbook/hosting.md": "docs/hosting",
  "docs/handbook/extending.md": "docs/extending"
});

const trees = new Map();
export function documentTree(source) {
  if (!trees.has(source)) trees.set(source, unified().use(remarkParse).parse(readFileSync(resolve(publicationRoot, source), 'utf8')));
  return trees.get(source);
}
export function walkMarkdown(node, fn) { fn(node); for (const child of node.children || node.childNodes || []) walkMarkdown(child, fn); }
export function repositoryTarget(url, source) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    const absolute = new URL(url, 'https://schlessera.github.io');
    const prefix = '/schlessera/brain-kit/blob/main/';
    if (absolute.origin !== 'https://github.com' || !absolute.pathname.startsWith(prefix)) return null;
    url = '/' + absolute.pathname.slice(prefix.length);
  }
  const encoded = url.split(/[?#]/)[0];
  const path = decodeURIComponent(encoded);
  let target = encoded ? posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(source), path)) : source;
  if (target === '..' || target.startsWith('../') || target.includes('\\')) throw new Error(`Repository escape: ${source} -> ${url}`);
  const actual = resolve(publicationRoot, target);
  if (existsSync(actual) && statSync(actual).isDirectory() && existsSync(resolve(actual, 'README.md'))) target = posix.join(target, 'README.md');
  return target;
}
const routes = Object.values(publications);
for (const [source, route] of Object.entries(publications)) {
  if (!/^docs(?:\/[a-z0-9-]+)*$/.test(route) || routes.filter(candidate => candidate === route).length !== 1) throw new Error(`Publication route collision or invalid route: ${source} -> ${route}`);
}

export function documentTitle(source) {
  const heading = documentTree(source).children.find(node => node.type === 'heading' && node.depth === 1);
  return heading ? toString(heading) : posix.basename(source, '.md').replaceAll('-', ' ');
}

// The canonical index owns the labels, sections and reading order.
export const docNavigation = [];
let group;
const indexTree = documentTree('docs/handbook/README.md');
const definitions = new Map();
walkMarkdown(indexTree, node => { if (node.type === 'definition') definitions.set(node.identifier, node.url); });
for (const node of indexTree.children) {
  if (node.type === 'heading' && node.depth === 2) {
    group = { title: toString(node), items: [] }; docNavigation.push(group);
  } else if (group) walkMarkdown(node, child => {
    const url = child.type === 'link' ? child.url : child.type === 'linkReference' ? definitions.get(child.identifier) : null;
    if (!url) return;
    const source = repositoryTarget(url, 'docs/handbook/README.md');
    if (publications[source] && !group.items.some(item => item.source === source)) group.items.push({ source, route: publications[source], title: /\.md$/i.test(toString(child)) ? documentTitle(source) : toString(child) });
  });
}

export const chapters = docNavigation.flatMap(group => group.items);
