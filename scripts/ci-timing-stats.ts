/** Shared arithmetic for repository measurement tools; missing is never zero. */
export function seconds(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const elapsed = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}
export function stats(values: number[]) {
  const sorted = values.filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b), n = sorted.length;
  return { n, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p90: n ? sorted[Math.ceil(n * .9) - 1]! : null };
}
export function percentage(numerator: number, denominator: number) {
  return { numerator, denominator, percent: denominator ? 100 * numerator / denominator : null };
}
