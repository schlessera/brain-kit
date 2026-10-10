import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';

const directory = resolve(import.meta.dir, '../dist');
const manifest = await Bun.file(resolve(directory, 'build-manifest.json')).json();
const handbook = await Bun.file(resolve(directory, 'handbook.json')).json();
if (handbook.schemaVersion !== 1 || !handbook.publications) throw new Error('Missing handbook publication boundary');
const selectedSources = new Set<string>(Object.keys(handbook.publications));
for (const source of selectedSources) {
  if (!/^docs\/handbook\/[a-z-]+\.md$/.test(source) && source !== 'docs/handbook/README.md') throw new Error(`Non-handbook source published: ${source}`);
}
const expectedRoutes = ['docs', 'docs/concepts', 'docs/quickstart', 'docs/daily-workflow', 'docs/organizing', 'docs/agents', 'docs/interface', 'docs/search', 'docs/configuration', 'docs/modules', 'docs/hosting', 'docs/extending'];
if (JSON.stringify(Object.values(handbook.publications).sort()) !== JSON.stringify(expectedRoutes.sort())) throw new Error('Handbook learning path changed; review its publication boundary');
const sitemap = await Bun.file(resolve(directory, 'sitemap.xml')).text();
const sitemapUrls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]).sort();
const expectedUrls = [`https://schlessera.github.io${manifest.base}`, ...expectedRoutes.map(route => `https://schlessera.github.io${manifest.base}${route}/`)].sort();
if (JSON.stringify(sitemapUrls) !== JSON.stringify(expectedUrls)) throw new Error('Sitemap includes material outside the curated handbook');
const documents = new Map<string, any>();
const errors: string[] = [];
function walk(node: any, fn: (node: any) => void) { fn(node); for (const child of node.childNodes || []) walk(child, fn); }
function textContent(node: any): string { return node.value || (node.childNodes || []).map(textContent).join(''); }
for (const [path, hash] of Object.entries(manifest.files)) {
  const file = Bun.file(resolve(directory, path));
  if (createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex') !== hash) errors.push(`Artifact digest changed: ${path}`);
  if (path.endsWith('.html')) documents.set(path, parse(await file.text()));
}
for (const [path, tree] of documents) {
  const current = `https://schlessera.github.io${manifest.base}${path.replace(/index\.html$/, '')}`;
  const ids = new Set<string>();
  walk(tree, node => { const id = node.attrs?.find((a: any) => a.name === 'id')?.value; if (id) { if (ids.has(id)) errors.push(`Duplicate id ${id}: ${path}`); ids.add(id); } });
  walk(tree, node => {
    for (const attr of node.attrs || []) {
      if (!['href', 'src'].includes(attr.name) || /^(?:mailto:|tel:|data:)/.test(attr.value)) continue;
      const url = new URL(attr.value, current);
      if (node.nodeName === 'a' && attr.name === 'href') {
        const property = (name: string) => node.attrs.find((attribute: any) => attribute.name === name)?.value;
        const isExternal = ['http:', 'https:'].includes(url.protocol) && url.origin !== 'https://schlessera.github.io';
        if (isExternal) {
          const icon = node.childNodes?.some((child: any) => child.nodeName === 'svg' && child.attrs?.some((attribute: any) => attribute.name === 'class' && attribute.value.includes('external-icon')));
          const accessibleLabel = node.childNodes?.some((child: any) => child.nodeName === 'span' && textContent(child).includes(`external site: ${url.host}`));
          if (property('data-external') !== url.host || !icon || !accessibleLabel) errors.push(`Unmarked external link: ${path} -> ${attr.value}`);
          const ownMarkdown = url.hostname === 'github.com' && url.pathname.startsWith('/schlessera/brain-kit/blob/') && /\.md$/i.test(url.pathname);
          const currentSource = url.pathname.startsWith(`/schlessera/brain-kit/blob/${manifest.sourceSha}/`) || url.pathname.startsWith('/schlessera/brain-kit/blob/main/');
          const repositoryPath = decodeURIComponent(url.pathname.split('/').slice(5).join('/'));
          if (ownMarkdown && currentSource && selectedSources.has(repositoryPath) && property('data-source-link') === undefined) errors.push(`Handbook chapter escaped to GitHub: ${path} -> ${attr.value}`);
        } else if (property('data-external') !== undefined) errors.push(`Internal link marked external: ${path} -> ${attr.value}`);
      }
      if (url.origin !== 'https://schlessera.github.io') continue;
      if (!url.pathname.startsWith(manifest.base)) { errors.push(`Missing base: ${path} -> ${attr.value}`); continue; }
      const target = decodeURIComponent(url.pathname.slice(manifest.base.length)) || 'index.html';
      const targetFile = target.endsWith('/') ? `${target}index.html` : target;
      if (!(targetFile in manifest.files)) { errors.push(`Missing built target: ${path} -> ${attr.value}`); continue; }
      if (url.hash && documents.has(targetFile)) {
        let found = false;
        walk(documents.get(targetFile), child => { if (child.attrs?.some((a: any) => a.name === 'id' && a.value === decodeURIComponent(url.hash.slice(1)))) found = true; });
        if (!found) errors.push(`Missing built fragment: ${path} -> ${attr.value}`);
      }
    }
  });
}
// Every page shares the packaged 1200x630 social card (#1427): an absolute
// og:image whose bytes are in this build, and the brand files in the head and
// header come from @schlessera/brain-ui-kit rather than a site-drawn copy.
// `demo/` holds the embedded apps' iframe documents, which no link shares.
for (const [path, tree] of documents) {
  if (path.startsWith('demo/')) continue;
  const metas: Record<string, string> = {};
  const icons: string[] = [];
  walk(tree, node => {
    const attr = (name: string) => node.attrs?.find((a: any) => a.name === name)?.value;
    if (node.nodeName === 'meta' && (attr('property') || attr('name'))) metas[attr('property') || attr('name')] = attr('content');
    if (node.nodeName === 'link' && ['icon', 'apple-touch-icon'].includes(attr('rel'))) icons.push(attr('href'));
  });
  const image = metas['og:image'];
  if (!image || !image.startsWith(`https://schlessera.github.io${manifest.base}`)) { errors.push(`Missing absolute og:image: ${path}`); continue; }
  const imageFile = decodeURIComponent(new URL(image).pathname.slice(manifest.base.length));
  if (!(imageFile in manifest.files)) { errors.push(`og:image is not in the build: ${path} -> ${image}`); continue; }
  const png = Buffer.from(await Bun.file(resolve(directory, imageFile)).arrayBuffer());
  if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630) errors.push(`og:image is not a 1200x630 PNG: ${path} -> ${image}`);
  for (const key of ['og:title', 'og:description', 'twitter:card']) if (!metas[key]) errors.push(`Missing ${key}: ${path}`);
  if (icons.length !== 3 || icons.some(icon => !/\/(?:favicon|apple-touch-icon)\.[\w-]+\.(?:ico|svg|png)$/.test(icon))) errors.push(`Head icons are not the packaged favicon set: ${path} -> ${icons.join(', ')}`);
}
if ('favicon.svg' in manifest.files) errors.push('The site still ships its own favicon.svg drawing');
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Verified ${documents.size} HTML pages, every local URL/fragment and ${Object.keys(manifest.files).length} artifact digests at ${manifest.base}.`);
const shares = Bun.spawn(['bun', resolve(import.meta.dir, 'check-share-proof.ts')], { stdout: 'inherit', stderr: 'inherit' });
if (await shares.exited) throw new Error('Website share guard proof failed');
const publication = Bun.spawn(['bun', resolve(import.meta.dir, 'check-publication.ts')], { stdout: 'inherit', stderr: 'inherit' });
if (await publication.exited) throw new Error('Website publication proof failed');
// Publication workspaces are git archives; the selector runs in the original
// checkout before assembly, so its offline proof runs there too.
const selection = Bun.spawn(['bun', resolve(import.meta.dir, 'check-selection.ts')], { cwd: process.env.WEBSITE_CONTENT_ROOT || resolve(import.meta.dir, '../..'), stdout: 'inherit', stderr: 'inherit' });
if (await selection.exited) throw new Error('Website release selection proof failed');
if (!process.argv.includes('--static')) {
  const process = Bun.spawn(['bun', resolve(import.meta.dir, 'browser-check.ts'), ...globalThis.process.argv.includes('--no-capture') ? ['--no-capture'] : []], { stdout: 'inherit', stderr: 'inherit' });
  if (await process.exited) throw new Error('Website browser verification failed');
}
