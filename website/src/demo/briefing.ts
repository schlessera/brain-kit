// The daily briefing for the demo brain, as the whatsup skill writes it from
// `brain briefing`'s data: grouped by what matters today, people, places,
// projects, dates and states marked as entities so they read at a glance,
// and almost no links, because a briefing is read, not clicked through.
// The wording is staged like the demo's other answers; every figure in it is
// read from the records, so a changed record changes the briefing.
import { library } from '../../../packages/ui-kit/fixtures/library/index.ts';
import { estateDays, estateGuests, estateStores } from '../../../packages/ui-kit/fixtures/money.ts';
import { REFERENCE_DATE } from '../../../packages/ui-kit/fixtures/time.ts';
import { graphHealth } from './knowledge.ts';

const DAY = 86_400_000;
const record = (path: string) => {
  const found = library.find(item => item.path === path);
  if (!found) throw Error(`The briefing names a record the library does not hold: ${path}`);
  return found;
};
/** A figure the briefing quotes must be in the record it comes from. */
function from(path: string, ...figures: string[]) {
  const text = `${record(path).summary ?? ''} ${record(path).body}`;
  for (const figure of figures) if (!text.includes(figure)) throw Error(`${path} does not state ${figure}`);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Written out by hand, not through Intl, so the text is the same in every locale.
const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const thousands = (n: number) => n.toString().replace(/\B(?=(\d{3})+$)/g, ',');
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export function briefingMarkdown(): string {
  const checklist = record('ogygia/build/departure-checklist.md');
  const open = checklist.body.split('\n').filter(line => line.startsWith('- [ ] ')).length;
  const done = checklist.body.split('\n').filter(line => line.startsWith('- [x] ')).length;
  from('studies/water-ration.md', '18 litres', '34');
  const wine = estateStores.find(store => store.label.startsWith('wine'))!;
  const winePerDay = wine.consumed / estateDays;
  const wineLeft = Math.round((wine.held - wine.consumed) / winePerDay);
  const ambush = record('ithaca/news/day-3646-ambush.md'), medon = record('ithaca/news/day-3648-medon.md'), sparta = record('ithaca/news/day-3649-sparta.md');
  from(sparta.path, 'Menelaus', 'Calypso');
  const inbox = library.filter(item => item.path.startsWith('inbox/') && !item.status).sort((a, b) => a.created.localeCompare(b.created));
  const landfall = '2026-07-29';
  return [
    '## Today',
    '',
    `- **Launch** (<proj>Leaving Ogygia</proj>) — <st>TODAY</st> on the seven o'clock tide; ${done} of ${done + open} checklist items done, <st>${open} OPEN</st>, water first.`,
    `- **Water** (<proj>Raft stores</proj>) — one skin, about 18 litres, against 34 for <d>17 days</d>; two more jars <st>NOT ABOARD</st>.`,
    `- **Weather** (<ev>Dawn wind</ev>) — light, offshore and from astern this morning; <p>Calypso</p> promised a fair wind.`,
    '',
    '## Ahead',
    '',
    `- **Landfall** (<ev>Scheria</ev>) — <st>PLANNED</st> for <d>${day(landfall)}</d>, ${days(REFERENCE_DATE, landfall)} days out, about 632 km on a heading near 50°.`,
    `- **Steering** (<proj>Crossing</proj>) — keep the <ev>Great Bear</ev> on the left hand; it turned all night on <d>${day('2026-07-10')}</d> and never set.`,
    '',
    '## Ithaca',
    '',
    `- **Word at Sparta** (<p>Telemachus</p>) — <p>Menelaus</p> told him on <d>${day(sparta.created)}</d> that you are alive, held by <p>Calypso</p>.`,
    `- **Ambush** (<co>Suitors</co>) — a ship and twenty men in the strait for his return since <d>${day(ambush.created)}</d>; <st>AT RISK</st>.`,
    `- **The hall** (<p>Penelope</p>) — learned from <p>Medon</p> on <d>${day(medon.created)}</d> that her son sailed and is hunted.`,
    `- **Estate** (<co>Household</co>) — ${estateGuests} guests for ${thousands(estateDays)} days; wine ${thousands(wine.consumed)} of ${thousands(wine.held)} jars gone, <st>FIRST TO RUN OUT</st>, about ${wineLeft} days left.`,
    '',
    '## The brain',
    '',
    `- **Inbox** — <st>${inbox.length} UNPROCESSED</st> captures, the oldest from <d>${month(inbox[0].created)}</d>.`,
    `- **Links** — <st>${graphHealth.brokenLinks} BROKEN</st> to notes never written, ${graphHealth.orphans} notes link nowhere; Graph › Maintenance lists them.`,
  ].join('\n');
}

/**
 * The retired streaming route, frame for frame, for released panels that still
 * POST to it: a start, one progress line per output line, then done. Newer
 * panels read `GET /api/brain/briefing`; both carry the same text.
 */
export function briefingStream(): Response {
  const lines = briefingMarkdown().split('\n');
  const encoder = new TextEncoder();
  const frame = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ type: 'start', text: 'Running whatsup briefing...' }));
      for (const line of lines) controller.enqueue(frame({ type: 'progress', text: line }));
      controller.enqueue(frame({ type: 'done', success: true, text: 'Briefing complete' }));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
