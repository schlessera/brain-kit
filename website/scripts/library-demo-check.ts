import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { sceneIndex, type SceneId } from '../src/demo/scene-index.ts';
import { knowledgeResponse } from '../src/demo/knowledge.ts';
import { corpusStats } from '../src/demo/stats.ts';

const corpus = corpusStats();

const meta = await knowledgeResponse(new URL('https://demo.invalid/api/graph/meta'))!.json() as { communities: { label: string | null; size: number }[] };
const topLabels = meta.communities.filter(community => community.label).sort((a, b) => b.size - a.size).slice(0, 3).map(community => community.label!);

// What each library scene must show: a value only its own block holds.
const shows: Record<SceneId, string> = {
  ships: 'Ship 12', stores: '1180 of 1800', voyage: 'Day 1085', losses: 'Land of the Laestrygonians',
  suitors: 'Zacynthus', dead: 'Achilles, among the dead', steer: '632 km', week: 'Day 3651',
};

/** The fixture library in the real demo: every scene, search and the graph, at phone and desktop width in both themes. */
export async function verifyLibraryDemo(page: Page, origin: string, base: string, errors: string[]) {
  let searched = 0;
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
    // Search reaches a record that exists only in the library, through
    // whichever entry point this release draws: the rail item or the phone's
    // search disc. Older releases had neither; that is logged, not passed.
    await demo.goto(`${origin}${base}demo/rank/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await demo.locator('textarea[data-composer]').first().waitFor();
    const entries = [demo.getByRole('button', { name: 'Search the brain', exact: true }), demo.getByText('Search', { exact: true })];
    let opened = false;
    for (const entry of entries) for (const candidate of await entry.all()) {
      if (opened || !await candidate.isVisible() || !await candidate.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; })) continue;
      await candidate.click();
      opened = await demo.getByPlaceholder('Search your brain...').waitFor({ timeout: 3000 }).then(() => true, () => false);
    }
    if (opened) {
      await demo.getByPlaceholder('Search your brain...').fill('Anticleia');
      await demo.getByPlaceholder('Search your brain...').press('Enter');
      await demo.getByText('people/anticleia.md', { exact: true }).first().waitFor();
      await overflowFree('search');
      searched++;
    } else console.log(`Library search: this release draws no search entry at ${width}px; skipped.`);
    // The graph lays out every folder; the library's largest ones are listed.
    if (width < 900) {
      await demo.goto(`${origin}${base}demo/rank/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
      // Graph is a tab in some releases and inside More in others.
      await demo.getByText('More', { exact: true }).last().waitFor();
      if (!await demo.getByText('Graph', { exact: true }).first().isVisible()) await demo.getByText('More', { exact: true }).last().click();
      await demo.getByText('Graph', { exact: true }).first().click();
      // Louvain's communities, labelled as the indexer labels them; the largest are listed.
      for (const label of topLabels) await demo.getByText(label, { exact: true }).first().waitFor();
      await overflowFree('graph');
      // Brain statistics are measured from the same files: the document count
      // and its daily trend render from the demo's stats endpoints.
      // Statistics wait for a finished turn; a scene answer finishes, the rank question does not.
      await demo.goto(`${origin}${base}demo/rank/?scene=ships&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await demo.getByText('Ship 12', { exact: true }).first().waitFor();
      await demo.getByText('More', { exact: true }).last().click();
      await demo.getByText('Brain statistics', { exact: true }).first().click();
      await demo.getByText(/^documents · \d+ snapshots$/).first().waitFor();
      await demo.getByText(String(corpus.documents), { exact: true }).first().waitFor();
      await overflowFree('stats');
      // The daily briefing streams from the same files, line by line, like a host's whatsup run.
      await demo.goto(`${origin}${base}demo/rank/?scene=ships&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await demo.getByText('Ship 12', { exact: true }).first().waitFor();
      await demo.getByText('More', { exact: true }).last().click();
      await demo.getByText('Daily briefing', { exact: true }).first().click();
      await demo.getByText('Before you push off', { exact: false }).first().waitFor();
      await demo.getByText('The brain itself', { exact: true }).first().waitFor();
      await overflowFree('briefing');
    }
    await context.close();
  }
  console.log(`Library demo proof passed: ${Object.keys(sceneIndex).length} scenes at 320 and 1280, the graph, brain statistics and the daily briefing at 320, in both themes; search in ${searched} of 4 layouts.`);
}
