import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { sceneIndex, type SceneId } from '../src/demo/scene-index.ts';

// What each library scene must show: a value only its own block holds.
const shows: Record<SceneId, string> = {
  ships: 'Ship 12', stores: '1180 of 1800', voyage: 'Day 1085', losses: 'Land of the Laestrygonians',
  suitors: 'Zacynthus', dead: 'Achilles, among the dead', steer: '632 km', week: 'Day 3651',
};

/** The fixture library in the real demo: every scene, search and the graph, at phone and desktop width in both themes. */
export async function verifyLibraryDemo(page: Page, origin: string, base: string, errors: string[]) {
  for (const [width, theme] of [[320, 'light'], [320, 'dark'], [1280, 'light'], [1280, 'dark']] as const) {
    const context = await page.context().browser()!.newContext({ viewport: { width, height: 900 }, locale: 'en-GB', timezoneId: 'Etc/GMT-2' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); errors.push(`External library demo request: ${url.origin}`); return route.abort(); });
    const demo = await context.newPage(); demo.setDefaultTimeout(8000); demo.on('pageerror', error => errors.push(`${width}/${theme}: ${error.message}`));
    const overflowFree = async (where: string) => assert(await demo.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Library demo overflow: ${where} at ${width}/${theme}`);
    for (const id of Object.keys(sceneIndex) as SceneId[]) {
      await demo.goto(`${origin}${base}demo/rank/?scene=${id}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await demo.getByText(sceneIndex[id].prompt, { exact: true }).first().waitFor();
      await demo.getByText(shows[id], { exact: false }).first().waitFor();
      await overflowFree(`scene ${id}`);
    }
    // Search reaches a record that exists only in the library.
    await demo.goto(`${origin}${base}demo/rank/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
    if (width >= 900) await demo.getByText('Search', { exact: true }).first().click();
    else await demo.getByRole('button', { name: 'Search the brain', exact: true }).click();
    await demo.getByPlaceholder('Search your brain...').fill('Anticleia');
    await demo.getByPlaceholder('Search your brain...').press('Enter');
    await demo.getByText('people/anticleia.md', { exact: true }).first().waitFor();
    await overflowFree('search');
    // The graph lays out every folder; the library's largest ones are listed.
    if (width < 900) {
      await demo.goto(`${origin}${base}demo/rank/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await demo.getByText('More', { exact: true }).last().click();
      await demo.getByText('Graph', { exact: true }).click();
      for (const folder of ['ithaca', 'journal', 'ogygia', 'crew']) await demo.getByText(folder, { exact: true }).first().waitFor();
      await overflowFree('graph');
    }
    await context.close();
  }
}
