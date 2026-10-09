import { resolve, sep } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createRenderer } from '../../packages/ui-render-puppeteer/src/index.ts';
import { buildHtmlDocument } from '../../packages/render-template/src/index.ts';
import { binaryDocuments } from '../src/demo/odyssey.ts';
import { canonicalExport, exportKey, type ExportCatalogue } from '../src/demo/export-key.ts';
import type { RenderRequest } from '../../packages/ui-sdk/src/protocol.ts';
import { exportRecipeHash, repository } from './export-recipe.ts';
import { pngMetadata } from './png-metadata.ts';

const website = resolve(repository, 'website');
const dist = resolve(website, 'dist');
const manifest = await Bun.file(resolve(dist, 'build-manifest.json')).json();
const output = resolve(website, 'public/assets/shares');
const staging = resolve(website, '.astro/share-generation');
const recipeHash = await exportRecipeHash();
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(manifest.base)) return new Response('Not found', { status: 404 });
  const path = url.pathname.slice(manifest.base.length);
  const target = resolve(dist, path.endsWith('/') ? `${path}index.html` : path);
  if (!target.startsWith(dist + sep)) return new Response('Not found', { status: 404 });
  const index = Bun.file(resolve(target, 'index.html'));
  if (await index.exists()) return new Response(index);
  const file = Bun.file(target); return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
// GitHub's Ubuntu runner restricts user namespaces. This offline build renders
// only our checked-in fictional fixtures; scripts and network remain disabled.
const renderer = createRenderer({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', maxConcurrent: 2, noSandbox: true });
const index: ExportCatalogue = { schemaVersion: 1, recipeHash, exports: {}, files: {} };
const provenance: Record<string, { key: string; format: string; title?: string; sha256: string; bytes: number }> = {};


try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'en-GB', timezoneId: 'Etc/GMT-2' });
  const errors: string[] = [];
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); errors.push(`External request: ${url.origin}`); return route.abort(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}${manifest.base}demo/rank/?catalogue=1&theme=light`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof (window as any).__brainDemoCatalogue === 'function');
  await page.evaluate(() => document.fonts.ready);
  const requests: RenderRequest[] = await page.evaluate(() => (window as any).__brainDemoCatalogue());
  if (errors.length) throw Error(errors.join('\n'));
  const unique = new Map<string, RenderRequest>();
  for (const request of requests) {
    const key = await exportKey(request);
    // Diagram image and PDF requests legitimately have different content.
    for (const format of request.contentType === 'html' && request.content.includes('mermaid-figure') ? [request.format] : ['png', 'pdf'] as const) unique.set(`${key}.${format}`, { ...request, format });
  }
  let fontCss = await Bun.file(resolve(website, 'public/assets/fonts.css')).text();
  const matches = [...fontCss.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)];
  for (const match of matches) {
    const path = match[1].slice(match[1].indexOf('assets/') + 7);
    const bytes = await Bun.file(resolve(website, 'public/assets', path)).arrayBuffer();
    fontCss = fontCss.replace(match[1], `data:font/ttf;base64,${Buffer.from(bytes).toString('base64')}`);
  }
  let finished = 0;
  const entries = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (let offset = 0; offset < entries.length; offset += 2) {
    await Promise.all(entries.slice(offset, offset + 2).map(async ([asset, request]) => {
      const key = asset.split('.')[0];
      const content = JSON.parse(canonicalExport(request)).content;
      let html = buildHtmlDocument({ ...request, content, linkPolicy: 'visible-destinations' });
      html = html.replace('</head>', `<style>${fontCss}</style></head>`);
      let bytes: Uint8Array = await (request.format === 'png' ? renderer.renderPng({ html, linkPolicy: 'visible-destinations' }) : renderer.renderPdf({ html, linkPolicy: 'visible-destinations' }));
      if (request.format === 'png') bytes = pngMetadata(bytes, { kind: 'production-ui-export', scenario: 'Odyssey', referenceDate: '2026-07-12', recipeHash, contentKey: key, title: request.title || 'Shared from Brain' });
      await Bun.write(resolve(staging, asset), bytes);
      const record = index.exports[key] ||= { png: '', pdf: '' };
      record[request.format] = asset;
      provenance[asset] = { key, format: request.format, title: request.title, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
      finished++;
    }));
    if (finished % 20 === 0 || finished === entries.length) console.log(`Generated ${finished}/${entries.length} faithful PNG/PDF exports.`);
  }
  for (const binary of binaryDocuments) {
    const sourceName = binary.source.split('/').at(-1);
    const request = requests.find(request => request.title === sourceName);
    if (!request) throw Error(`No exact export for ${binary.source}`);
    const asset = index.exports[await exportKey(request)][binary.format];
    index.files[binary.path] = { asset, mime: binary.format === 'png' ? 'image/png' : 'application/pdf', size: provenance[asset].bytes };
  }
  await Bun.write(resolve(staging, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  await Bun.write(resolve(staging, 'provenance.json'), JSON.stringify({ kind: 'production-renderer-exports', recipeHash, sourceSha: manifest.sourceSha, sourceDirty: manifest.dirty, brainKit: manifest.brainKit, referenceDate: '2026-07-12', browser: await browser.version(), runtime: Bun.version, assets: provenance }, null, 2) + '\n');
  await rm(output, { recursive: true, force: true });
  const { rename } = await import('node:fs/promises');
  await rename(staging, output);
  console.log(`Saved ${entries.length} exports and ${binaryDocuments.length} binary viewer fixtures. Rebuild the website to include them.`);
} finally { await browser.close(); await renderer.shutdown(); server.stop(true); }
