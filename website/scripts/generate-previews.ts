import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { pngMetadata } from './png-metadata.ts';

const website = resolve(import.meta.dir, '..');
const dist = resolve(website, 'dist');
const manifest = await Bun.file(resolve(dist, 'build-manifest.json')).json();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(manifest.base)) return new Response('Not found', { status: 404 });
  const relative = path.slice(manifest.base.length);
  const target = resolve(dist, relative.endsWith('/') ? `${relative}index.html` : relative);
  if (!target.startsWith(dist + sep)) return new Response('Not found', { status: 404 });
  const index = Bun.file(resolve(target, 'index.html'));
  const file = await index.exists() ? index : Bun.file(target);
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-partial-raster'] });
const views = [
  { scene: 'rank', theme: 'light', width: 390, height: 844, expected: 'What should we prepare first?', name: 'hero-decision-paper.png' },
  { scene: 'rich', theme: 'dark', width: 390, height: 844, expected: '17 days', name: 'hero-plan-dark.png' },
  { scene: 'work', theme: 'light', width: 1100, height: 760, expected: 'Prepare for departure', name: 'demo-work-desktop-paper.png' },
  { scene: 'voice', theme: 'light', width: 390, height: 660, expected: 'Check the water and provisions before launching the raft.', name: 'actual-voice-light-390.png' },
];
const assets: Record<string, object> = {};
try {
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Etc/GMT-2', reducedMotion: 'reduce' });
  const errors: string[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    errors.push(`External request: ${url.origin}`); return route.abort();
  });
  for (const view of views) {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.goto(`${origin}${manifest.base}demo/${view.scene}/?theme=${view.theme}`, { waitUntil: 'domcontentloaded' });
    await (view.scene === 'work' ? page.getByRole('heading', { name: view.expected, exact: true }) : page.getByText(view.expected, { exact: true })).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    const bytes = pngMetadata(await page.screenshot(), { kind: 'production-ui-preview', scenario: 'Odyssey', referenceDate: '2026-07-12', sourceSha: manifest.sourceSha, brainKit: manifest.brainKit, recipeHash: manifest.exportRecipeHash, viewport: [view.width, view.height], theme: view.theme });
    await Bun.write(resolve(website, 'public/assets/previews', view.name), bytes);
    assets[view.name] = { scene: view.scene, width: view.width, height: view.height, sha256: createHash('sha256').update(bytes).digest('hex') };
    await page.close();
  }
  if (errors.length) throw Error(errors.join('\n'));
  await Bun.write(resolve(website, 'public/assets/previews/provenance.json'), JSON.stringify({ sourceSha: manifest.sourceSha, brainKit: manifest.brainKit, recipeHash: manifest.exportRecipeHash, browser: await browser.version(), assets }, null, 2) + '\n');
  console.log('Regenerated four fallback screenshots from the selected production UI.');
} finally { await browser.close(); server.stop(true); }
