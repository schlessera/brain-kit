import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import axe from 'axe-core';

export async function verifyDocumentation(page: Page, origin: string, base: string, captures: string, capture: boolean) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${origin}${base}docs/`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: axe.source });
  const article = page.locator('article.prose');
  const reference = article.getByRole('link', { name: 'Supported configuration and module formats', exact: true });
  assert.equal(await reference.getAttribute('href'), `${base}docs/supported-inputs/`);
  assert.equal(await reference.locator('.external-icon').count(), 0);
  assert.equal(await article.locator('a').evaluateAll(links => links.some(link => /^[\w./-]+\.md$/.test(link.textContent || ''))), false, 'Documentation index still labels pages as Markdown filenames');
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
    const violations = await page.evaluate(async () => (await (window as any).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
    assert.deepEqual(violations, [], `Documentation accessibility at ${width}/${theme}`);
    if (capture) await page.screenshot({ path: resolve(captures, `docs-${width}-${theme}.png`), fullPage: true });
  }

  await reference.click();
  await page.getByRole('heading', { name: 'Supported configuration and module formats', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `${base}docs/supported-inputs/`);
  const navigation = page.getByRole('navigation', { name: 'Documentation', exact: true });
  const referenceGroup = navigation.locator('details').filter({ has: page.getByText('Reference', { exact: true }) });
  await referenceGroup.locator('summary').focus();
  await referenceGroup.locator('summary').press('Enter');
  await navigation.getByRole('link', { name: 'Extending: embeddings', exact: true }).click();
  await page.getByRole('heading', { name: 'Extending: embeddings', exact: true }).waitFor();
  await page.locator('article.prose').getByRole('link', { name: 'Configuration', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, `${base}docs/configuration/`);
  assert.equal(new URL(page.url()).hash, '#embeddings');
  await page.locator('#embeddings').waitFor();

  await page.goto(`${origin}${base}docs/modules/`, { waitUntil: 'domcontentloaded' });
  await page.locator('article.prose').getByRole('link', { name: 'jobs package', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, `${base}docs/packages/module-jobs/`);
  await page.locator('article.prose h1').waitFor();
  console.log('Documentation browser proof passed: readable labels, internal references/package pages/fragments, keyboard navigation and visible/accessibly marked GitHub links.');
}
