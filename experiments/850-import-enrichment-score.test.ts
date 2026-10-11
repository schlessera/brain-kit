import { expect, test } from 'bun:test';
import { score, protectedFrontmatter, canonicalReport, type Prediction } from '../evals/850-import-enrichment/score.ts';

test('micro tag scoring counts omitted gold tags, extra tags and invalid rows', () => {
  const goldens = [{ id: 'one', split: 'held-out', type: 'note', tags: ['navigation', 'council'], summaryNeed: true }];
  const row: Prediction = { id: 'one', arm: 'candidate', repetition: 0, type: 'note', tags: ['navigation', 'stewardship'], needsSummary: true, completed: true, invalid: false, abstained: false, vetoes: [], summaries: [] };
  const result = score(goldens, [row, { ...row, repetition: 1, invalid: true }]);
  expect(result.tags).toEqual({ tp: 1, fp: 1, fn: 3, precision: .5, recall: .25, f1: 1 / 3 });
  expect(result.typeCorrect).toBe(1);
  expect(result.summaryNeedCorrect).toBe(1);
  expect(result.invalid).toBe(1);
});

test('vetoes and false completions remain counted in every repetition', () => {
  const goldens = [{ id: 'one', split: 'held-out', type: 'unclear', tags: [], summaryNeed: false }];
  const rows: Prediction[] = [0, 1, 2].map(repetition => ({ id: 'one', arm: 'current', repetition, type: 'ruling', tags: [], needsSummary: true, completed: true, invalid: false, abstained: false, vetoes: ['content-loss-or-rewrite'], summaries: [] }));
  const result = score(goldens, rows);
  expect(result.falseCompletions).toBe(3);
  expect(result.vetoes).toEqual({ 'content-loss-or-rewrite': 3 });
  expect(result.agreement).toEqual({ cases: 1, identical: 1 });
  expect(result.typeCorrect).toBe(0);
});

test('multiline mutable tags are allowed, while owner comments and fields stay protected', () => {
  const before = '---\ntitle: Ledger\n# Keep this comment.\ntags: []\nsummary: ""\n---\nBody\n';
  const after = '---\ntitle: Ledger\n# Keep this comment.\ntags:\n  - council\nsummary: Records retained\n---\nBody\n';
  expect(protectedFrontmatter(before, ['tags', 'summary'])).toBe(protectedFrontmatter(after, ['tags', 'summary']));
  expect(protectedFrontmatter(before, ['tags', 'summary'])).not.toBe(protectedFrontmatter(after.replace('# Keep this comment.\n', ''), ['tags', 'summary']));
  expect(protectedFrontmatter(before, ['summary'])).not.toBe(protectedFrontmatter(after, ['summary']));
});

test('consistent per-file reports score, while conflicting duplicate labels refuse', () => {
  expect(canonicalReport({ type: { one: 'logbook', two: 'logbook' }, tags: { one: ['navigation'], two: ['navigation'] }, needsSummary: [], completed: true }, ['one', 'two']))
    .toEqual({ type: 'logbook', tags: ['navigation'], needsSummary: false, completed: true });
  expect(() => canonicalReport({ type: { one: 'note', two: 'ruling' } }, ['one', 'two'])).toThrow('Conflicting per-file report');
});
