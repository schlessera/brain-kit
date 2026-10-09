import { resolve, relative } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';
import GithubSlugger from 'github-slugger';
import { parseFragment, serialize } from 'parse5';
import { publications, publicationRoot, repositoryTarget, documentTitle, docNavigation } from './publication.mjs';

// Astro also evaluates this module from its generated prerender directory.
export const repositoryRoot = publicationRoot;
export const base = process.env.SITE_BASE || '/brain-kit/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('SITE_BASE must have leading and trailing slashes');
export const sourceSha = process.env.WEBSITE_SOURCE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
export const site = 'https://schlessera.github.io';
export const repository = 'https://github.com/schlessera/brain-kit';
export const href = (path = '') => `${base}${path}`;
export const sourceUrl = (path, kind = 'blob', ref = sourceSha) => `${repository}/${kind}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;

function walk(node, fn) { fn(node); for (const child of node.children || node.childNodes || []) walk(child, fn); }
const ids = new Map();
function fragments(target) {
  if (ids.has(target)) return ids.get(target);
  const tree = unified().use(remarkParse).parse(readFileSync(resolve(repositoryRoot, target), 'utf8'));
  const found = new Set(); const slugger = new GithubSlugger();
  walk(tree, node => {
    if (node.type === 'heading') found.add(slugger.slug(toString(node)));
    if (node.type === 'html') walk(parseFragment(node.value), element => {
      for (const attr of element.attrs || []) if (attr.name === 'id' || attr.name === 'name') found.add(attr.value);
    });
  });
  ids.set(target, found); return found;
}

export function resolveLink(original, source, image = false) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(original)) {
    const url = new URL(original, site);
    const target = repositoryTarget(original, source);
    if (target && publications[target]) return resolveLink('/' + target + url.search + url.hash, source, image);
    // The canonical Pages URL in the project README follows the preview base.
    if (url.origin === site && (url.pathname === '/brain-kit' || url.pathname.startsWith('/brain-kit/'))) return href(url.pathname.slice('/brain-kit/'.length)) + url.search + url.hash;
    return original;
  }
  const [, encoded = '', query = '', fragment = ''] = original.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const target = repositoryTarget(original, source);
  const actual = resolve(repositoryRoot, target);
  if (!existsSync(actual)) throw new Error(`Missing target: ${source} -> ${original}`);
  if (fragment && /\.md$/i.test(target) && !fragments(target).has(decodeURIComponent(fragment.slice(1)))) throw new Error(`Missing fragment: ${source} -> ${original}`);
  if (image) throw new Error(`Unapproved documentation image: ${source} -> ${original}; add a deliberate asset mapping before publishing it`);
  if (!encoded) return query + fragment;
  if (publications[target]) return href(`${publications[target]}/`) + query + fragment;
  return sourceUrl(target, statSync(actual).isDirectory() ? 'tree' : 'blob') + query + fragment;
}

export function repositoryLinks() {
  return (tree, file) => {
    const source = relative(repositoryRoot, file.path).split('\\').join('/');
    const imageReferences = new Set();
    const definitions = new Map();
    walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier, node.url); });
    walk(tree, node => { if (node.type === 'imageReference') imageReferences.add(node.identifier); });
    walk(tree, node => {
      if (node.type === 'link' || node.type === 'linkReference') {
        const original = node.type === 'link' ? node.url : definitions.get(node.identifier);
        const target = original && repositoryTarget(original, source);
        // Human labels remain authored. A filename-only label becomes the
        // linked page's heading, including labels authored as inline code.
        if (target && publications[target] && /^(?:[\w./-]+\.md)$/i.test(toString(node))) node.children = [{ type: 'text', value: documentTitle(target) }];
      }
      if (['link', 'image', 'definition'].includes(node.type) && node.url) node.url = resolveLink(node.url, source, node.type === 'image' || imageReferences.has(node.identifier));
      if (node.type === 'html') {
        const fragment = parseFragment(node.value);
        walk(fragment, element => {
          for (const attr of element.attrs || []) if (attr.name === 'href' || attr.name === 'src') attr.value = resolveLink(attr.value, source, attr.name === 'src');
        });
        node.value = serialize(fragment);
      }
    });
  };
}

export { docNavigation, documentTitle };
