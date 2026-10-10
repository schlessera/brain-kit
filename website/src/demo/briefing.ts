// The daily briefing for the demo brain: `brain briefing`, the keyless,
// mechanical status the briefing panel shows (#1391). It is assembled here the
// way core assembles it (`generateBriefing`,
// `packages/core/src/cli/commands/briefing.ts:183-318`): sections in the same
// order and line shapes, each present only when it has rows, computed from
// the demo's own files. No model writes any of it.
import { REFERENCE_DATE } from '../../../packages/ui-kit/fixtures/time.ts';
import { documentByPath } from './corpus.ts';
import { graphHealth, indexed } from './knowledge.ts';

const DAY = 86_400_000;
// The demo brain declares no per-type windows, so every type takes core's
// default (`DEFAULT_STALENESS`).
const STALE_DAYS = 180;
const FOCUS = 'context/current-focus.md';
const { records, body } = indexed;
const field = (record: (typeof records)[number], key: string) => {
  const line = record.content.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];
  try { return line === undefined ? undefined : JSON.parse(line) as unknown; } catch { return line; }
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export function briefingMarkdown(): string {
  const lines: string[] = [];
  const today = REFERENCE_DATE;
  const focus = documentByPath[FOCUS];
  const live = records.filter(record => field(record, 'status') !== 'archived');

  // 1. Current focus, verbatim without frontmatter.
  if (focus) {
    lines.push('## Current Focus\n');
    lines.push(body(focus).trim());
    // 2. The documents it links to, most recently updated first.
    const linked = records.filter(record => focus.links.includes(record.path)).sort((a, b) => b.updated.localeCompare(a.updated));
    if (linked.length) {
      lines.push('\n## Focus-Linked Documents\n');
      for (const record of linked) lines.push(`- ${record.updated} | ${text(field(record, 'type'))} | ${record.path} | ${record.title} | ${text(field(record, 'summary'))}`);
    }
  }

  // 3. Deadlines in the next sixty days.
  const horizon = addDays(today, 60);
  const deadlines = live.map(record => ({ record, deadline: text(field(record, 'deadline')) })).filter(({ deadline }) => deadline >= today && deadline <= horizon).sort((a, b) => a.deadline.localeCompare(b.deadline) || a.record.path.localeCompare(b.record.path));
  if (deadlines.length) {
    lines.push('\n## Upcoming Deadlines\n');
    for (const { record, deadline } of deadlines) lines.push(`- ${deadline} | ${record.path} | ${record.title} | ${text(field(record, 'summary'))}`);
  }

  // 4. Overdue reviews, from `next_review`.
  const overdue = live.map(record => ({ record, due: text(field(record, 'next_review')) })).filter(({ due }) => due && due < today).sort((a, b) => a.due.localeCompare(b.due));
  if (overdue.length) {
    lines.push('\n## Overdue Reviews\n');
    for (const { record, due } of overdue.slice(0, 5)) lines.push(`- ${due} | ${record.path} | ${record.title}`);
    if (overdue.length > 5) lines.push(`- … and ${overdue.length - 5} more (brain audit)`);
  }

  // 4b. Upkeep. Broken links are this corpus's only warning-class audit
  // finding; orphans and staleness are informational and never must-fix.
  lines.push('\n## Upkeep\n', `- ${graphHealth.brokenLinks} must-fix audit finding(s) (errors and warnings; brain audit)`);

  // 5. Recently active primary documents. The demo marks none primary, so,
  // as in a brain that never sets `relevance`, the section is absent.
  const primary = live.filter(record => field(record, 'relevance') === 'primary').sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 15);
  if (primary.length) {
    lines.push('\n## Recently Active\n');
    for (const record of primary) lines.push(`- ${record.updated} | ${text(field(record, 'type'))} | ${record.path} | ${record.title} | ${text(field(record, 'summary')).slice(0, 80)}`);
  }

  // 6. Silently modified files need real file mtimes; the demo has none.

  // 7. Stale documents, most overdue first.
  const now = Date.parse(`${today}T00:00:00Z`);
  const stale = live.map(record => ({ record, age: Math.floor((now - Date.parse(`${record.updated}T00:00:00Z`)) / DAY) })).filter(({ age }) => age > STALE_DAYS).sort((a, b) => b.age - a.age || a.record.path.localeCompare(b.record.path));
  if (stale.length) {
    lines.push('\n## Stale Documents\n');
    for (const { record, age } of stale) lines.push(`- ${record.updated} (${age}d ago) | ${record.path} | ${record.title}`);
  }
  return lines.join('\n');
}

/**
 * The retired streaming route, frame for frame, for released panels that still
 * POST to it: a start, one progress line per output line, then done. Newer
 * panels read `GET /api/brain/briefing`; both carry the same keyless text.
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
