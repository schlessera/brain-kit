// Prepared answers over the fixture library; `scene-index.ts` holds their
// prompts so the first chunk can route a turn without loading the library. Each scene is the text an agent
// would write plus the blocks it would show, built from the same records the
// file tree, search and graph serve, so an answer never states a figure the
// records do not hold.
import { library, shipRecords, type LibraryDocument } from '../../../packages/ui-kit/fixtures/library/index.ts';
import { crewLosses, estateBars, estateDays, estateGuests } from '../../../packages/ui-kit/fixtures/money.ts';
import { notes } from '../../../packages/ui-kit/fixtures/notes.ts';
import { people } from '../../../packages/ui-kit/fixtures/people.ts';
import { goal, projects } from '../../../packages/ui-kit/fixtures/projects.ts';
import { sceneIndex, type SceneId } from './scene-index.ts';
import { BLOCK_SCHEMA, type Block } from '../../../packages/ui-sdk/src/tool-contracts/blocks.ts';

export interface SceneContent { text: string; blocks: Block[] }

const byPath = new Map(library.map(record => [record.path, record]));
const link = (path: string) => `[[${path.replace(/\.md$/, '')}]]`;
const day = (record: LibraryDocument) => Number(record.fields?.day ?? record.path.match(/day-(\d+)/)?.[1]);
const files = (records: LibraryDocument[]): Block => ({ kind: 'files', items: records.slice(0, 8).map(record => ({ path: record.path, reason: record.summary.slice(0, 240) })) });
function need(path: string) {
  const record = byPath.get(path);
  if (!record) throw Error(`Scene names a record the library does not hold: ${path}`);
  return record;
}

/** The first blockquote in a record, verbatim, so a quote card never paraphrases. */
function quote(path: string) {
  const line = need(path).body.split('\n').find(text => text.startsWith('> '));
  if (!line) throw Error(`Scene quotes a record with no quotation: ${path}`);
  return line.slice(2).trim();
}
/** A figure the answer states must appear in the record it cites. */
function holds(path: string, ...figures: string[]) {
  for (const figure of figures) if (!need(path).body.includes(figure)) throw Error(`${path} does not state ${figure}`);
  return path;
}

const ships = [...shipRecords].sort((a, b) => a.ship - b.ship);
const legs = library.filter(record => record.path.startsWith('voyage/legs/') && record.status !== 'planned').sort((a, b) => day(a) - day(b));
const week = library.filter(record => record.path.startsWith('journal/day-') && day(record) >= 3645).sort((a, b) => day(a) - day(b));

export const scenes: Record<SceneId, SceneContent> = {
  ships: {
    text: `Twelve ships left Troy with fifty aboard each. Eleven were lost together in the Laestrygonian harbour; the twelfth, Odysseus's own, was wrecked off Thrinacia. No ship returned. Each roster is in ${link(ships[0].path)} and the eleven after it.`,
    blocks: [{ kind: 'table', columns: [{ label: 'Ship' }, { label: 'Embarked', align: 'right' }, { label: 'Lost', align: 'right' }, { label: 'Where' }], rows: ships.map(ship => ({ cells: [
      { v: ship.ship === 1 ? 'Ship 1 (his own)' : `Ship ${ship.ship}` }, { v: String(ship.embarked), mono: true },
      { v: String(Object.values(ship.lost).reduce((a, n) => a + n, 0)), mono: true },
      { v: Object.entries(ship.lost).filter(([, n]) => n).map(([place, n]) => `${place} ${n}`).join(' · ') },
    ] })) }],
  },
  stores: {
    text: `The share of each store consumed in the hall, as last reported: ${estateGuests} guests over ${estateDays.toLocaleString('en-GB')} days, and nobody has been invoiced. The ledger is in [[ithaca/estate]].`,
    blocks: [{ kind: 'bars', rows: estateBars.map(row => ({ label: row.label, pct: row.pct, value: row.value })) }],
  },
  voyage: {
    text: `${legs.length} legs from Troy to Ogygia, dated by days since Troy fell. The planned crossing to Scheria is not on this list because it has not happened. Start at ${link(legs[0].path)}.`,
    blocks: [{ kind: 'timeline', items: legs.map(record => ({ time: `Day ${day(record)}`, title: record.title, detail: record.summary })) }],
  },
  losses: {
    text: 'Six hundred embarked and six hundred were lost, at six places. Odysseus is the sole survivor. The loss records give each count with its cause.',
    blocks: [{ kind: 'bars', rows: crewLosses.map(loss => ({ label: loss.place, pct: Math.max(1, Math.round(loss.lost / 6)), value: `${loss.lost}` })) }, files(library.filter(record => record.path.startsWith('crew/losses/')))],
  },
  suitors: {
    text: `As last reported, 108 suitors from four islands, with [[people/antinous]] at their head. These are group counts by home island; the named men have their own records. The ledger is ${link(holds('ithaca/suitors/roster.md', '108', '52', '24', '20', '12'))}.`,
    blocks: [
      { kind: 'table', columns: [{ label: 'Home island' }, { label: 'Suitors', align: 'right' }], rows: [['Dulichium', '52'], ['Same', '24'], ['Zacynthus', '20'], ['Ithaca', '12'], ['Total', '108']].map(([island, men]) => ({ cells: [{ v: island, bold: island === 'Total' }, { v: men, mono: true, bold: island === 'Total' }] })) },
      files(library.filter(record => record.path.startsWith('ithaca/suitors/'))),
    ],
  },
  dead: {
    text: `On day 620, at the pit by the Acheron, [[people/teiresias]] gave the forecast and the shades came after him. [[people/anticleia]] told him what had killed her. [[people/agamemnon]] advised a secret landing, and [[people/achilles]] would not be consoled.`,
    blocks: [
      { kind: 'quote', quote: quote('people/agamemnon.md'), source: 'Agamemnon, among the dead', locator: 'people/agamemnon.md', note: 'The advice to keep for the landing on Ithaca.' },
      { kind: 'quote', quote: quote('people/achilles.md'), source: 'Achilles, among the dead', locator: 'people/achilles.md' },
      files(['knowledge/rites-for-the-dead.md', 'knowledge/order-of-the-shades.md', 'people/anticleia.md', 'people/agamemnon.md', 'people/achilles.md'].map(need)),
    ],
  },
  steer: {
    text: `Calypso's directions, worked into numbers in ${link(holds('studies/steering-by-the-bear.md', '632', '50 degrees'))}: keep the Great Bear on the left hand and hold a heading of about 50 degrees. The crossing is planned, not made; Scheria is a planned landfall.`,
    blocks: [
      { kind: 'stats', tiles: [
        { label: 'To Scheria', value: '632 km', meta: 'planned' },
        { label: 'Passage', value: '17 days', meta: 'planned' },
        { label: 'Heading', value: '50°', meta: 'east of north' },
      ] },
      files(['studies/steering-by-the-bear.md', 'studies/crossing-distance-and-margin.md', 'knowledge/great-bear.md', 'studies/water-ration.md'].map(need)),
    ],
  },
  week: {
    text: `${week.length} journal entries since day 3645: the hawk, Hermes and the oath, the four days of the build, and the eagle. Read them in order from ${link(week[0].path)}.`,
    // A journal title is its day number, which the time column already shows.
    blocks: [{ kind: 'timeline', items: week.map(record => ({ time: `Day ${day(record)}`, title: record.summary })) }],
  },
};

// A scene that names a record nobody holds fails at module load, so a broken
// answer link cannot reach the build.
const known = new Set([...library, ...notes, ...people, ...projects, goal].map(record => record.path));
for (const scene of Object.values(scenes)) for (const [, slug] of scene.text.matchAll(/\[\[([^\]]+)\]\]/g)) if (!known.has(`${slug}.md`)) throw Error(`Scene links a missing record: ${slug}`);
for (const [id, scene] of Object.entries(scenes)) for (const value of scene.blocks) if (!BLOCK_SCHEMA.safeParse(value).success) throw Error(`Scene ${id} shows a block the product would refuse: ${value.kind}`);
for (const id of Object.keys(sceneIndex)) if (!(id in scenes)) throw Error(`Scene ${id} has no prepared answer`);
