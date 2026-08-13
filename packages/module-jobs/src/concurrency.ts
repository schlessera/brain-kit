/**
 * Bounded-concurrency helpers for adapters that follow listing pages down to
 * per-job detail pages. Detail enrichment turns one request per board into one
 * request per job, so the fan-out needs a ceiling: boards rate-limit, and a
 * hundred parallel requests is both rude and a fast route to a 429.
 */

/**
 * Map over `items` running at most `limit` tasks concurrently, preserving
 * input order in the result. A task that rejects yields `null` in its slot
 * rather than failing the whole batch — one dead detail page should not lose
 * the other 99.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(workers);
  return results;
}
