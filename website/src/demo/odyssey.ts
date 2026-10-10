import { notes } from '../../../packages/ui-kit/fixtures/notes.ts';
import { people } from '../../../packages/ui-kit/fixtures/people.ts';
import { places } from '../../../packages/ui-kit/fixtures/places.ts';
import { goal, projects, launchChecklist, straitChoice, voyageSteps } from '../../../packages/ui-kit/fixtures/projects.ts';
import { crewLosses, crewTable } from '../../../packages/ui-kit/fixtures/money.ts';
import { REFERENCE_DATE, REFERENCE_INSTANT } from '../../../packages/ui-kit/fixtures/time.ts';
import { BLOCK_SCHEMA, type Block } from '../../../packages/ui-sdk/src/tool-contracts/blocks.ts';

export const referenceNow = REFERENCE_INSTANT.getTime();
// `featured` records are the staged set with prepared PNG/PDF exports. Library
// records are browsable, searchable and graphed, and share as text formats.
export interface DemoDocument { path: string; title: string; kind: 'markdown' | 'html' | 'text'; content: string; links: string[]; updated: string; featured: boolean }
/** The staged records, before the library joins them in `corpus.ts`. */
export const documents = new Map<string, DemoDocument>();
export function document(path: string, title: string, type: string, body: string, links: string[] = [], updated = REFERENCE_DATE, fields: Record<string, unknown> = {}, featured = true) {
  const metadata = { title, type, created: updated, updated, ...fields };
  const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  const related = links.length ? `\n\n## Related records\n\n${links.map(link => `- [[${link.replace(/\.md$/, '')}]]`).join('\n')}` : '';
  documents.set(path, { path, title, kind: 'markdown', content: `---\n${frontmatter}\n---\n\n# ${title}\n\n${body}${related}\n`, links, updated, featured });
}
for (const note of notes) document(note.path, note.title, note.kind, note.excerpt, note.links, note.updated, { tags: note.tags.map(tag => tag.slice(1)), status: 'recorded' });
for (const person of people) {
  const existing = documents.get(person.path);
  const location = places.find(place => place.id === person.at)?.name || 'Not recorded';
  document(person.path, person.name, 'person', `## Relationship\n\n${person.relationship}\n\n## Last known standing\n\n| Field | Record |\n| --- | --- |\n| Role | ${person.role} |\n| Location | ${location} |\n| Standing | ${person.standing} |\n\n${existing ? `## Latest note\n\n${existing.content.split('\n\n').slice(2, 3).join('\n\n')}` : 'This is a fictional relationship record, not a current communication channel.'}`, [...new Set([...(existing?.links || []), goal.path])], existing?.updated || REFERENCE_DATE, { status: ['person:eurylochus', 'person:elpenor', 'person:teiresias'].includes(person.id) ? 'deceased' : 'recorded', tags: ['people'], aliases: [person.name.toLowerCase()] });
}
for (const project of projects) document(project.path, project.title, 'project', `${project.summary}\n\n## Next context\n\n${project.id === 'project:sail-home' ? 'The raft is ready on Ogygia. The passage to Scheria is planned for seventeen days; arrival and help are not guaranteed.' : project.id === 'project:estate' ? 'Penelope holds the household. Telemachus is seeking news in Sparta. Return is the only action Odysseus can take from here.' : project.id === 'project:crew' ? 'The ledger is closed. None of the six hundred crew survived. Odysseus is the sole survivor, and none of the twelve ships returned.' : 'Four days of work are complete. Water and provisions still need a final review before departure.'}`, [goal.path, ...project.people.map(id => people.find(person => person.id === id)!.path)], REFERENCE_DATE, { status: project.status, deadline: project.deadline, tags: ['voyage'] });

export const preparationTable = `| Preparation | Current record | Before launch |\n| --- | --- | --- |\n| Raft | Twenty trees; deck, bulwarks and sail complete | Review lashings and ballast |\n| Water | One skin; seventeen days planned | Review the shortfall |\n| Provisions | Bread and wine offered by Calypso | Bring stores aboard |\n| Navigation | Keep the Great Bear on the left | Read the directions once more |`;
export const crewMarkdown = `| Where | Lost | Cause |\n| --- | ---: | --- |\n${crewLosses.map(loss => `| ${loss.place} | ${loss.lost} | ${loss.cause} |`).join('\n')}\n| **Total** | **600** | **No crew survivors** |`;
export const departureDiagram = 'flowchart TD\n  A[Raft built on Ogygia] --> B[Review water and provisions]\n  B --> C[Launch: 12 July]\n  C --> D[Planned passage: 17 days]\n  D --> E[Scheria: planned 29 July]\n  E --> F[Seek passage to Ithaca]';
document('voyage/ogygia/raft.md', 'The raft on Ogygia', 'project', `Twenty trees, four days, one adze. The deck, bulwarks, ballast and sail are complete. Calypso supplied the tools and cut the sail.\n\n## Launch checklist\n\n${launchChecklist.map(step => `- [${step.state === 'done' ? 'x' : ' '}] ${step.title}${step.detail ? ` — ${step.detail}` : ''}`).join('\n')}\n\n## Supplies review\n\n${preparationTable}`, ['people/calypso.md', 'voyage/ogygia/departure-plan.md', 'notes/raft-preparations.md'], REFERENCE_DATE, { status: 'ready', tags: ['route'], aliases: ['raft'] });
document('voyage/ogygia/departure-plan.md', 'Departure from Ogygia', 'plan', `## The next seventeen days\n\nLaunch is planned for 12 July. Scheria is the planned landfall on 29 July, not a reported arrival. Calypso's directions are to keep the Great Bear on the left hand and sail east of north.\n\n${preparationTable}\n\n## Passage sequence\n\n${voyageSteps.map(step => `- **${step.title}** — ${step.detail}`).join('\n')}\n\n## Review before leaving\n\n- [ ] Water and provisions aboard\n- [ ] Lashings and ballast checked\n- [ ] Directions reviewed\n\nThe original crew are all dead. This crossing is being attempted alone.`, ['voyage/ogygia/raft.md', 'people/calypso.md', 'goals/return-to-ithaca.md', 'voyage/ogygia/passage.mmd'], REFERENCE_DATE, { status: 'planned', deadline: '2026-07-29', tags: ['route', 'ithaca'], aliases: ['departure-plan', 'leaving-ogygia'] });
document('notes/raft-preparations.md', 'Raft preparations', 'note', `The vessel is ready; the provisions need a final review.\n\n${preparationTable}\n\n## What changed\n\nThe four-day build is complete. Review the water shortfall before committing to seventeen days at sea.\n\n## Open questions\n\n- How should the available water be rationed?\n- Is there a safer way to stow the supplies?`, ['voyage/ogygia/raft.md', 'people/calypso.md'], REFERENCE_DATE, { status: 'active', tags: ['route'] });
document('projects/leaving-ogygia.md', 'Leaving Ogygia', 'project', 'The launch preparations are collected in the voyage plan. This is a working record for the departure, not a promise of safe arrival.', ['voyage/ogygia/departure-plan.md', 'voyage/ogygia/raft.md'], REFERENCE_DATE, { status: 'active', tags: ['route'] });
document('crew/manifest-0012.md', 'The twelve-ship manifest', 'ledger', `Six hundred crew embarked in twelve ships at Troy. Every loss is accounted for below.\n\n${crewMarkdown}\n\n## Closing entry\n\nNo crew survived after Thrinacia. Odysseus is the sole survivor. No ships returned. This is a historical ledger; there is no crew available for the new crossing.`, ['crew/_index.md', 'crew/eurylochus.md', 'crew/elpenor.md', 'decisions/scylla-or-charybdis.md'], REFERENCE_DATE, { status: 'closed', tags: ['crew'] });
document('decisions/scylla-or-charybdis.md', 'Scylla or Charybdis', 'decision', `## The count\n\nCirce described both hazards before the strait. Scylla meant six certain losses; Charybdis risked the ship and every person aboard.\n\n| Consideration | Scylla | Charybdis |\n| --- | --- | --- |\n| Losses | Six men | All hands at risk |\n| Ship | Survives | Lost in a swallow |\n| Certainty | Certain | Three times a day |\n| Advice | Circe recommended this shore | Avoid |\n\n## Decision and consequence\n\nDecided: Scylla. Held the Calabrian shore; six were taken from the deck. Those six are included in the closed crew ledger.\n\n> The crew were warned about Charybdis and not about Scylla. That silence is the part still worth reviewing.\n\n## Questions retained\n\n- [ ] Would the six have rowed if they had known?\n- [ ] Did this silence weaken trust before Thrinacia?`, ['knowledge/scylla.md', 'knowledge/charybdis.md', 'people/circe.md', 'crew/manifest-0012.md'], REFERENCE_DATE, { status: 'settled', cost: '6 men', source: 'Circe', tags: ['crew', 'danger', 'route'], aliases: ['scylla-or-charybdis'] });
const additional: Record<string, [string, string, string[]]> = {
  'knowledge/sirens.md': ['The Sirens', 'Circe warned of the song. The crew used wax; Odysseus was bound to the mast. The vessel passed without stopping.', ['people/circe.md', 'voyage/day-1041-sirens.md']],
  'notes/do-not-give-my-name.md': ['Do not give my name', 'Written before leaving the Cyclops: he cannot complain about a man he cannot name. The instruction was ignored from the stern, after the ship was clear.', ['decisions/name-at-the-stern.md', 'people/polyphemus.md']],
  'crew/eurylochus.md': ['Eurylochus: crew record', 'Second in command. Died with the remaining crew after the cattle of Helios were killed on Thrinacia. No current action can be assigned to him.', ['decisions/cattle-of-helios.md', 'crew/manifest-0012.md']],
  'crew/elpenor.md': ['Elpenor: crew record', 'Died after falling from a roof on Aeaea. His loss is counted in the six-hundred-person ledger.', ['crew/manifest-0012.md']],
  'context/current-focus.md': ['Current focus', 'Leave Ogygia with the raft, water and provisions. Keep the return to Ithaca as the goal; treat Scheria as the next planned landfall.', ['voyage/ogygia/departure-plan.md', goal.path]],
};
for (const [path, [title, body, links]] of Object.entries(additional)) document(path, title, path.split('/')[0] === 'crew' ? 'person' : 'note', body, links, REFERENCE_DATE, { status: path.startsWith('crew/') ? 'closed' : 'recorded', tags: [path.split('/')[0]] });
document('decisions/cattle-of-helios.md', 'The cattle on Thrinacia', 'decision', 'The crew had sworn not to touch the cattle. After weeks of adverse wind, the remaining men broke the oath while Odysseus slept. The storm that followed destroyed the ship and killed all thirty-one remaining crew.\n\nThe ledger counts six hundred losses across the entire voyage; thirty-one of them occurred here.', ['oaths/helios.md', 'knowledge/teiresias-forecast.md', 'crew/eurylochus.md', 'crew/manifest-0012.md'], REFERENCE_DATE, { status: 'closed', tags: ['crew', 'gods', 'danger'] });
documents.set('voyage/ogygia/passage.mmd', { path: 'voyage/ogygia/passage.mmd', title: 'Passage sequence', kind: 'text', content: departureDiagram, links: [], updated: REFERENCE_DATE, featured: true });
const briefHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Departure brief</title><style>body{font:18px/1.65 Georgia,serif;background:#f3f0e4;color:#12181b;padding:32px;max-width:680px;margin:auto}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%}th,td{padding:10px;text-align:left;border-bottom:1px solid #bbb}small{font:14px/1.5 sans-serif}</style></head><body><small>Fictional Odyssey record · 12 July 2026</small><h1>Departure from Ogygia</h1><p>The raft is built. Water and provisions need a final review. Calypso’s directions are to keep the Great Bear on the left.</p><table><tr><th>Departure</th><th>Passage</th><th>Landfall</th></tr><tr><td>12 July</td><td>17 days planned</td><td>Scheria, 29 July planned</td></tr></table><h2>Before launch</h2><ul><li>Bring the water, bread and wine aboard.</li><li>Review lashings and ballast.</li><li>Read the directions once more.</li></ul><p>The crossing is being attempted alone. None of the original crew survived.</p></body></html>';
documents.set('voyage/ogygia/departure-brief.html', { path: 'voyage/ogygia/departure-brief.html', title: 'Departure brief', kind: 'html', content: briefHtml, links: [], updated: REFERENCE_DATE, featured: true });
export const binaryDocuments = [
  { path: 'voyage/ogygia/departure-plan.png', source: 'voyage/ogygia/departure-plan.md', format: 'png' },
  { path: 'voyage/ogygia/departure-plan.pdf', source: 'voyage/ogygia/departure-plan.md', format: 'pdf' },
  { path: 'crew/manifest-0012.pdf', source: 'crew/manifest-0012.md', format: 'pdf' },
] as const;
const supportingFiles = { kind: 'files', items: [
  { path: 'voyage/ogygia/departure-plan.md', reason: 'The plan, supplies and open questions.' },
  { path: 'crew/manifest-0012.md', reason: 'The historical crew ledger.' },
  { path: 'decisions/scylla-or-charybdis.md', reason: 'The decision and its recorded cost.' },
] };
// Older releases predate the native supporting-files block. Keep their real
// Markdown wiki-link presentation rather than synthesizing a newer component.
const parsedFiles = BLOCK_SCHEMA.safeParse(supportingFiles);
export const corpusBlocks = {
  crew: { kind: 'table', ...crewTable },
  decision: { kind: 'comparison', ...straitChoice, footnote: 'A recorded decision before Thrinacia; the losses are in the closed crew ledger.' },
  steps: { kind: 'steps', variant: 'checklist', steps: launchChecklist },
} satisfies Record<string, Block>;
export const supportingFilesBlock = parsedFiles.success ? parsedFiles.data : null;
// The staged set as this module leaves it: `corpus.ts` later adds the goal and
// the library to the same map, so a reader that needs only the staged records
// (the service worker's embedded copy) takes this snapshot, not the live map.
export const stagedPaths: ReadonlySet<string> = new Set(documents.keys());
