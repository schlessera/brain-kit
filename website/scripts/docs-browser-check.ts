import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import axe from 'axe-core';

export async function verifyDocumentation(page: Page, origin: string, base: string, captures: string, capture: boolean) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${origin}${base}docs/`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: axe.source });
  const article = page.locator('article.prose');
  await article.getByRole('heading', { name: 'The brain-kit handbook', exact: true }).waitFor();
  const firstChapter = article.getByRole('link', { name: 'How your brain works', exact: true }).first();
  assert.equal(await firstChapter.getAttribute('href'), `${base}docs/concepts/`);
  assert.equal(await firstChapter.locator('.external-icon').count(), 0);
  assert.equal(await page.locator('.docs-nav details').count(), 4, 'Handbook sections became an engineering catalog');
  assert.equal(await page.locator('.docs-nav li a').count(), 11, 'Handbook navigation includes unselected references');
  assert.equal(await article.locator('a').evaluateAll(links => links.some(link => /^[\w./-]+\.md$/.test(link.textContent || ''))), false, 'Handbook still labels pages as Markdown filenames');
  const engineering = article.getByRole('link', { name: /engineering documentation on GitHub/ });
  assert.match((await engineering.getAttribute('href')) || '', /github\.com\/schlessera\/brain-kit\/blob\/[^/]+\/docs\/README\.md$/);
  assert(await engineering.locator('.external-icon').isVisible(), 'Engineering archive was not visibly marked external');
  const source = article.getByRole('link', { name: /View Markdown source/ });
  assert.equal(await source.getAttribute('data-external'), 'github.com');
  assert(await source.locator('.external-icon').isVisible(), 'GitHub source link has no visible external icon');
  assert((await source.getAttribute('title'))?.includes('github.com'));
  assert((await source.textContent())?.includes('external site: github.com'));

  for (const [width, theme] of [[1280, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('.theme-toggle').click();
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Documentation overflow at ${width}/${theme}`);
    if (width === 390) {
      assert.equal(await page.locator('.docs-menu').getAttribute('open'), null, 'Mobile navigation did not start collapsed');
      const heading = await article.locator('h1').boundingBox();
      assert(heading && heading.y < 250, 'Mobile navigation pushed the article below the first viewport');
      await page.locator('.docs-menu-toggle').focus();
      await page.locator('.docs-menu-toggle').press('Enter');
      assert(await page.getByRole('navigation', { name: 'Documentation', exact: true }).isVisible(), 'Keyboard could not reveal mobile documentation navigation');
      const current = page.locator('.docs-nav a[aria-current=page]');
      assert(await current.isVisible(), 'Current documentation page is hidden inside the open menu');
      assert(Number.parseFloat(await current.evaluate(link => getComputedStyle(link).paddingLeft)) >= 20, 'Current page label touches the selection edge');
      await page.locator('.docs-menu-toggle').press('Enter');
    }
    const violations = await page.evaluate(async () => (await (window as any).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
    assert.deepEqual(violations, [], `Documentation accessibility at ${width}/${theme}`);
    if (capture) await page.screenshot({ path: resolve(captures, `docs-${width}-${theme}.png`), fullPage: true });
  }

  await firstChapter.click();
  await page.getByRole('heading', { name: 'How your brain works', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `${base}docs/concepts/`);
  await page.getByRole('navigation', { name: 'Reading order' }).getByRole('link', { name: /Create your first brain/ }).click();
  await page.getByRole('heading', { name: 'Create your first brain', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `${base}docs/quickstart/`);
  await page.getByRole('navigation', { name: 'Reading order' }).getByRole('link', { name: /Capture and find/ }).click();
  await page.getByRole('heading', { name: 'Capture and find', exact: true }).waitFor();
  await page.locator('.docs-menu-toggle').click();
  const navigation = page.getByRole('navigation', { name: 'Documentation', exact: true });
  const everyday = navigation.locator('details').filter({ has: page.getByText('Everyday use', { exact: true }) });
  assert(await navigation.locator('a[aria-current=page]').isVisible(), 'Selected chapter was hidden in a collapsed section');
  await everyday.locator('summary').focus();
  await everyday.locator('summary').press('Enter');
  assert.equal(await everyday.getAttribute('open'), null, 'Everyday section did not close from the keyboard');
  await everyday.locator('summary').press('Enter');

  await page.goto(`${origin}${base}docs/configuration/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Configure your brain', exact: true }).waitFor();
  const configuration = page.locator('article.prose').getByRole('link', { name: /complete configuration reference on GitHub/ });
  assert.match((await configuration.getAttribute('href')) || '', /github\.com\/schlessera\/brain-kit\/blob\/[^/]+\/docs\/configuration\.md$/);
  assert.equal(await configuration.getAttribute('data-external'), 'github.com');
  assert(await configuration.locator('.external-icon').isVisible(), 'Detailed configuration reference has no external marker');

  await page.goto(`${origin}${base}docs/modules/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Add domain workflows', exact: true }).waitFor();
  assert.equal(await page.locator('article.prose a[href*="/docs/packages/"]').count(), 0, 'Module inventories were published as handbook chapters');
  await page.goto(`${origin}${base}docs/supported-inputs/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Project reference', exact: true }).waitFor();
  assert.equal(await page.locator('article.prose h2').count(), 0, 'Retired reference content was ingested again');
  const handoff = page.locator('article.prose').getByRole('link', { name: /Read the reference on GitHub/ });
  assert((await handoff.getAttribute('href'))?.endsWith('/docs/supported-inputs.md'));
  assert(await handoff.locator('.external-icon').isVisible());
  console.log('Handbook browser proof passed: curated navigation, guided reading, external engineering references, archive handoffs, keyboard navigation and accessibility.');
}
