// The whole demo brain: the staged records from `odyssey.ts` plus the ui-kit
// fixture library. Kept apart so the browser loads it on first use rather
// than in the landing page's first chunk; Node scripts import it directly.
import { goal, projects } from '../../../packages/ui-kit/fixtures/projects.ts';
import { REFERENCE_DATE } from '../../../packages/ui-kit/fixtures/time.ts';
import { library } from '../../../packages/ui-kit/fixtures/library/index.ts';
import { binaryDocuments, document, documents, type DemoDocument } from './odyssey.ts';

const libraryHubs = library.filter(record => record.type === 'index');
document(goal.path, goal.title, 'goal', `${goal.stated}\n\n## Where things stand\n\nTen years at Troy, then ten years trying to return. Seven of those years were spent on Ogygia. The raft has been built; the crossing and the return to Ithaca are still ahead.\n\n## The work that serves this goal\n\n${projects.map(project => `- **${project.title}:** ${project.summary}`).join('\n')}\n\n## Where the records live\n\n${libraryHubs.map(hub => `- [[${hub.path.replace(/\.md$/, '')}]] — ${hub.summary}`).join('\n')}`, [...projects.map(project => project.path), ...libraryHubs.map(hub => hub.path)], REFERENCE_DATE, { status: 'active', tags: ['ithaca', 'route'] });
// The library is added last and never replaces a staged record: a collision is
// a fixture bug, not an override.
for (const record of library) {
  if (documents.has(record.path)) throw Error(`Library record collides with a staged demo record: ${record.path}`);
  document(record.path, record.title, record.type, record.body, record.links, record.updated, { created: record.created, status: record.status, tags: record.tags, ...(record.aliases ? { aliases: record.aliases } : {}), summary: record.summary, ...record.fields }, false);
}
export const demoDocuments = [...documents.values()].sort((a, b) => a.path.localeCompare(b.path));
export const documentByPath: Record<string, DemoDocument> = Object.assign(Object.create(null), Object.fromEntries(demoDocuments.map(record => [record.path, record])));
const paths = [...demoDocuments.map(record => record.path), ...binaryDocuments.map(record => record.path)];
export const directories = new Set(['', ...paths.flatMap(path => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/')))]);
export function treeEntries(directory: string) {
  const prefix = directory ? `${directory}/` : '';
  const entries = [...directories].filter(path => path && path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(path => ({ path, name: path.slice(prefix.length), type: 'dir' as const }));
  const files = paths.filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(path => ({ path, name: path.slice(prefix.length), type: 'file' as const }));
  return [...entries.sort((a, b) => a.name.localeCompare(b.name)), ...files.sort((a, b) => a.name.localeCompare(b.name))];
}
export const wikilinks: Record<string, string> = {};
for (const record of demoDocuments.filter(record => record.kind === 'markdown')) {
  for (const slug of [record.path.replace(/\.md$/, ''), record.path.split('/').at(-1)!.replace(/\.md$/, ''), record.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')]) wikilinks[slug.toLowerCase()] = record.path;
}
export { binaryDocuments };
