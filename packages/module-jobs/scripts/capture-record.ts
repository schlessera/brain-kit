/**
 * The one form a `capture.json` is committed in.
 *
 * `measure-boards.ts --seal` writes it and `tests/fixture-records.test.ts`
 * holds every committed record to it, so both import this rather than keep a
 * copy each. It lives apart from the script because the script runs its CLI
 * when imported.
 *
 * Non-ASCII is written literally: an em dash committed as `—` is the
 * same record, but a reseal rewrites it into a diff nobody asked for (#237).
 */
export function serializeCaptureRecord(record: { captures: Array<{ fixture: string }> }): string {
  const captures = [...record.captures].sort((a, b) => a.fixture.localeCompare(b.fixture));
  return `${JSON.stringify({ ...record, captures }, sortedKeys, 2)}\n`;
}

/** Stable key order, so a reseal is a no-op diff. */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}
