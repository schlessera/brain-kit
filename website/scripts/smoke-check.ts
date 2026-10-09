import assert from 'node:assert/strict';
import type { Page } from 'playwright';

export async function smokeEmbeddedApps(page: Page) {
  const cases = [
    ['left', 'What should we prepare first?'],
    ['right', '17 days'],
    ['desktop', 'Prepare for departure'],
    ['capture', 'Check the water and provisions before launching the raft.'],
  ] as const;
  for (const [side, content] of cases) {
    const iframe = page.locator(`iframe[data-side=${side}]`);
    await iframe.scrollIntoViewIfNeeded();
    const frame = page.frameLocator(`iframe[data-side=${side}]`);
    await (side === 'desktop' ? frame.getByRole('heading', { name: content, exact: true }) : frame.getByText(content, { exact: true })).waitFor({ timeout: 15000 });
    const size = await frame.locator('#app').boundingBox();
    assert(size && size.width > 100 && size.height > 100, `${side}: embedded app did not paint a usable surface`);
    assert(await frame.locator('body').evaluate(() => document.fonts.check('16px "Plus Jakarta Sans"')), `${side}: product font did not load`);
    console.log(`Smoke passed: ${side} app mounted and painted its expected scenario.`);
  }
  await page.evaluate(() => scrollTo(0, 0));
}
