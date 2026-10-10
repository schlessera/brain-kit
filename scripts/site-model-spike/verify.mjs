import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { repositoryRoot, routes, sourceUrl } from './model.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [resolve(repositoryRoot, 'packages/ui-kit')] }));
const [origin, mount] = process.argv.slice(2);
assert(origin && mount, 'Usage: node verify.mjs <local-preview-origin> <base>');
assert(new URL(origin).hostname === '127.0.0.1', 'Verify only the local experiment');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const [source, route] of Object.entries(routes)) {
    const response = await page.goto(`${origin}${mount}${route}/`);
    assert.equal(response.status(), 200, route);
    assert((await page.locator('main').innerText()).length > 100, `Nonempty Markdown: ${source}`);
    assert.equal(await page.locator('[data-source]').getAttribute('href'), sourceUrl(source));
    assert.equal(await page.locator('script').count(), 0, 'Static content needs no browser JS');
  }
  await page.goto(`${origin}${mount}experiment/nested/links/`);
  const expected = {
    'Quickstart': `${mount}docs/quickstart/#4-first-capture-and-first-search`,
    'Hosting index': `${mount}docs/hosting/`,
    'Repository root path': `${mount}docs/concepts/#frontmatter-schema`,
    'Query and fragment': `${mount}docs/cli/?from=experiment#search--context`,
    'Reference-style quickstart': `${mount}docs/quickstart/`,
    'Source code': sourceUrl('packages/core/src/cli/brain.ts'),
    'unmapped directory': sourceUrl('docs/decisions/', 'tree'),
  };
  for (const [label, href] of Object.entries(expected)) {
    const link = page.getByRole('link', { name: label, exact: true });
    assert.equal(await link.getAttribute('href'), href, `Resolved ${label}`);
    if (href.startsWith(mount)) {
      await link.click();
      assert.equal(page.url(), `${origin}${href}`, `Navigated ${label}`);
      const fragment = new URL(page.url()).hash.slice(1);
      if (fragment) assert.equal(await page.locator(`[id="${fragment}"]`).count(), 1, `Fragment exists: ${label}`);
      await page.goto(`${origin}${mount}experiment/nested/links/`);
    }
  }
  const img = page.getByRole('img');
  assert.equal(await img.getAttribute('src'), `${mount}assets/experiment-route.svg`);
  assert(await img.evaluate(e => e.complete && e.naturalWidth === 300), 'Image bytes decoded');
  assert.equal(await page.locator('table tbody tr').innerText(), 'Odysseus\tIthaca', 'GFM table has content');
  assert((await page.locator('pre').innerText()).includes('brain search "Sirens"'), 'Code fence rendered');
  await page.getByText('Markdown remains the source', { exact: true }).click();
  assert.equal(await page.locator('details').getAttribute('open'), '', 'Raw HTML disclosure operates');
  console.log(`PASS ${mount}: 8 nonempty pages, source links, 7 sample links, fragments, decoded SVG, GFM, code, details, no browser scripts`);
} finally {
  await browser.close();
}
