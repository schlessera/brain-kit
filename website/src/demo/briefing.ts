// The daily briefing (`/whatsup`) for the demo brain. A real host runs the
// whatsup skill: `brain briefing` gathers deadlines, focus, recent and stale
// records, and an agent writes 15-30 terse lines from them. Here the same
// gathering runs over the demo's files and the same shape of answer is
// written from what it finds, so every line points at a record that holds it.
import { library } from '../../../packages/ui-kit/fixtures/library/index.ts';
import { REFERENCE_DATE } from '../../../packages/ui-kit/fixtures/time.ts';
import { graphHealth } from './knowledge.ts';
import { referenceNow } from './odyssey.ts';

const DAY = 86_400_000;
const link = (path: string) => `[[${path.replace(/\.md$/, '')}]]`;
const since = (days: number) => new Date(referenceNow - days * DAY).toISOString().slice(0, 10);
const daysUntil = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${REFERENCE_DATE}T00:00:00Z`)) / DAY);
const record = (path: string) => {
  const found = library.find(item => item.path === path);
  if (!found) throw Error(`The briefing names a record the library does not hold: ${path}`);
  return found;
};

export function briefingMarkdown(): string {
  const checklist = record('ogygia/build/departure-checklist.md');
  const open = checklist.body.split('\n').filter(line => line.startsWith('- [ ] ')).map(line => line.slice(6));
  const done = checklist.body.split('\n').filter(line => line.startsWith('- [x] ')).length;
  const news = library.filter(item => item.path.startsWith('ithaca/news/day-') && item.created >= since(7)).sort((a, b) => b.created.localeCompare(a.created));
  const omens = library.filter(item => item.path.startsWith('omens/') && item.created >= since(3)).sort((a, b) => b.created.localeCompare(a.created));
  const journal = library.filter(item => item.path.startsWith('journal/day-')).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 2);
  const unprocessed = library.filter(item => item.path.startsWith('inbox/') && !item.status);
  const landfall = daysUntil('2026-07-29');
  return [
    '**Today: launch from Ogygia, planned for the seven o’clock tide.** Scheria is a planned landfall in ' + `${landfall} days, not a reported one.`,
    '',
    `**Before you push off** — ${done} done, ${open.length} open on ${link(checklist.path)}:`,
    ...open.slice(0, 5).map(item => `- ${item}`),
    ...(open.length > 5 ? [`- …and ${open.length - 5} more on the checklist`] : []),
    '',
    '**Ithaca, as reported this week**',
    ...news.slice(0, 4).map(item => `- ${item.summary ?? item.title} — ${link(item.path)}`),
    '',
    '**Signs since the build ended**',
    ...omens.map(item => `- ${item.title} — ${link(item.path)}`),
    '',
    '**The brain itself**',
    `- ${unprocessed.length} inbox captures still unprocessed; start with ${link(unprocessed[0].path)}`,
    `- ${graphHealth.brokenLinks} links point at notes never written; ${graphHealth.orphans} notes link nowhere — see Graph › Maintenance`,
    `- Last written: ${journal.map(item => link(item.path)).join(', ')}`,
  ].join('\n');
}

/** The host's stream, frame for frame: a start, one progress line per line of output, then done. */
export function briefingStream(): Response {
  const lines = briefingMarkdown().split('\n');
  const encoder = new TextEncoder();
  const frame = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ type: 'start', text: 'Running whatsup briefing...' }));
      let index = 0;
      // Paced like a model writing, so the panel's loading state is honest.
      const next = () => {
        if (index < lines.length) { controller.enqueue(frame({ type: 'progress', text: lines[index++] })); timer = setTimeout(next, 45); return; }
        controller.enqueue(frame({ type: 'done', success: true, text: 'Briefing complete' }));
        controller.close();
      };
      timer = setTimeout(next, 600);
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
