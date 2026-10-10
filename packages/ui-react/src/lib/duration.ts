/** Elapsed time for a timeline row: "0.4s", "12.3s", "2m 5s". */
export function formatDuration(ms: number): string {
  // Server and browser clocks can skew; a negative duration is just 0.
  ms = Math.max(0, ms);
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
