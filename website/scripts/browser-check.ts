import { resolve, sep } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import axe from 'axe-core';
import { verifyDeviceGeometry, verifyRichDemo } from './rich-demo-check.ts';
import { smokeEmbeddedApps } from './smoke-check.ts';
import { verifyDocumentation } from './docs-browser-check.ts';

const website = resolve(import.meta.dir, '..');
const directory = resolve(website, 'dist');
const manifest = await Bun.file(resolve(directory, 'build-manifest.json')).json();
const captures = resolve(website, '.impeccable/review');
await mkdir(captures, { recursive: true });
const diagnostics = resolve(website, 'test-results');
await rm(diagnostics, { recursive: true, force: true });
await mkdir(diagnostics, { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(manifest.base)) return new Response('Not found', { status: 404 });
  const path = decodeURIComponent(url.pathname.slice(manifest.base.length));
  const target = resolve(directory, !path || path.endsWith('/') ? `${path}index.html` : path);
  if (!target.startsWith(directory + sep)) return new Response('Not found', { status: 404 });
  const index = Bun.file(resolve(target, 'index.html'));
  if (await index.exists()) return new Response(index);
  const file = Bun.file(target); return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-partial-raster'] });
const context = await browser.newContext({ viewport: { width: 1448, height: 1086 }, locale: 'en-GB', timezoneId: 'Etc/GMT-2', reducedMotion: 'reduce' });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const errors: string[] = [];
const egress: string[] = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
  egress.push(url.origin); return route.abort();
});
async function settled() {
  await page.evaluate(() => document.fonts.ready);
  for (const frame of page.frames().slice(1)) await frame.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}
try {
  await page.goto(`${origin}${manifest.base}`, { waitUntil: 'domcontentloaded' });
  await settled();
  await smokeEmbeddedApps(page);
  if (process.argv.includes('--recapture-320')) {
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    for (const selector of ['iframe[data-side=left]', 'iframe[data-side=right]', 'iframe[data-side=desktop]', 'iframe[data-side=capture]']) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.frameLocator(selector).locator('#app').waitFor();
      await page.frameLocator(selector).getByText(selector.includes('desktop') ? 'Prepare for departure' : selector.includes('capture') ? 'Check the water and provisions before launching the raft.' : selector.includes('right') ? '17 days' : 'What should we prepare first?', { exact: true }).waitFor();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await settled();
    await page.screenshot({ path: resolve(captures, 'user-320-light.png'), fullPage: true });
    console.log('Replaced 320px light capture after all four embedded views were ready.');
    await browser.close(); server.stop(true); process.exit(0);
  }
  assert.equal(await page.locator('h1').textContent(), 'A second brainthat goes with you.');
  if (!process.argv.includes('--no-capture')) await page.screenshot({ path: resolve(captures, 'hero-repro.png') });
  if (process.argv.includes('--hero')) { console.log(JSON.stringify({ errors, egress })); }
  else {
    const left = page.frameLocator('iframe[data-side=left]');
    const right = page.frameLocator('iframe[data-side=right]');
    const raftPriority = left.getByRole('button', { name: 'Check the raft, position 2 of 3', exact: true });
    await raftPriority.focus();
    await raftPriority.press('Alt+ArrowUp');
    await left.getByRole('button', { name: 'Submit order', exact: true }).click();
    await left.getByText(/Your first priority is the raft/).waitFor();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await left.getByRole('button', { name: 'Keep this order', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Follow the work', exact: true }).click();
    await left.getByRole('heading', { name: 'Prepare for departure', exact: true }).waitFor();
    await right.getByRole('button', { name: 'Allow', exact: true }).first().click();
    await right.getByText('The staged archive was approved. No real file changed.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await right.getByRole('button', { name: /deny|reject/i }).first().click();
    await right.getByText('The staged archive was denied. No real file changed.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await left.getByText('Check the water and provisions before launching the raft.', { exact: false }).waitFor();
    await left.getByRole('button', { name: 'Edit', exact: true }).click();
    await left.locator('textarea[data-composer]').fill('Show the departure plan.');
    await left.locator('textarea[data-composer]').press('Enter');
    await left.getByText("Here's the staged departure plan.", { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Explore', exact: true }).click();
    await left.getByText('Water and provisions', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Decide', exact: true }).click();
    await settled();
    await verifyRichDemo(page, origin, manifest.base, captures, !process.argv.includes('--no-capture'), errors);
    await page.addScriptTag({ content: axe.source });
    for (const width of [1440, 1280, 900, 390, 320]) {
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: 1000 });
        if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('.theme-toggle').click();
        await settled();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Page overflow at ${width}/${theme}`);
        await verifyDeviceGeometry(page);
        for (const frame of page.frames().slice(1)) assert(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `App iframe overflow at ${width}/${theme}`);
        if (width === 320) {
          await page.locator('iframe[data-side=capture]').scrollIntoViewIfNeeded();
          const send = page.frameLocator('iframe[data-side=capture]').getByRole('button', { name: 'Send', exact: true }).first();
          await send.waitFor();
          assert(await send.evaluate(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44; }), `Dictation Send clipped or too short at ${width}/${theme}`);
          await page.evaluate(() => window.scrollTo(0, 0));
        }
        if (width === 1440 || width === 320) {
          const violations = await page.evaluate(async () => (await (window as any).axe.run({ exclude: [['iframe']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
          assert.deepEqual(violations, [], `Homepage accessibility at ${width}/${theme}`);
        }
        const name = width === 1440 && theme === 'dark' ? 'desktop.png' : width === 390 && theme === 'dark' ? 'mobile.png' : `user-${width}-${theme}.png`;
        if (!process.argv.includes('--no-capture')) await page.screenshot({ path: resolve(captures, name), fullPage: true });
      }
    }
    await verifyDocumentation(page, origin, manifest.base, captures, !process.argv.includes('--no-capture'));
    await page.goto(`${origin}${manifest.base}docs/quickstart/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create your first brain', exact: true }).waitFor();
    const source = await page.getByRole('link', { name: 'View Markdown source' }).getAttribute('href');
    assert(source?.includes(`/blob/${manifest.sourceSha}/docs/handbook/quickstart.md`));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await settled();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Docs overflow at ${width}`);
    }
    assert.deepEqual(egress, [], 'Demo made external requests');
    assert.deepEqual(errors, [], 'Browser runtime errors');
    console.log('Browser proof passed: staged decisions, both archive outcomes, capture, reset, responsive themes, docs and no external requests.');
  }
} catch (error) {
  await page.screenshot({ path: resolve(diagnostics, 'failure.png'), fullPage: true }).catch(() => {});
  await Bun.write(resolve(diagnostics, 'failure.txt'), `${String(error)}\nRuntime errors: ${JSON.stringify(errors)}\nExternal requests: ${JSON.stringify(egress)}\n`);
  throw error;
} finally {
  await context.tracing.stop({ path: resolve(diagnostics, 'browser-trace.zip') });
  await browser.close(); server.stop(true);
}
