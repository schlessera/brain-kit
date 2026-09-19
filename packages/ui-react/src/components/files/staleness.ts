/**
 * Staleness from `mtime` (design README, sixth pass §3b): "Stale needs only
 * `mtime` and a threshold, which every file already has — build it."
 *
 * The threshold is this app's, not the design's: the design gives no number
 * (D3's tree draws `stale 38d`, D6's switch says "untouched over 30 days",
 * and neither is a rule). 30 days is the D6 subtitle's own figure and the
 * shortest one the maintenance mode's stale slider offers, so a file the
 * Files rail calls stale is one the graph would too. Change it here and
 * both the rail and the tree's dots follow.
 */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since `mtime` (milliseconds since the epoch, as the server sends). */
export function ageInDays(mtime: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - mtime) / DAY_MS));
}

export function isStale(mtime: number, now = Date.now()): boolean {
  return ageInDays(mtime, now) >= STALE_AFTER_DAYS;
}

/** "today" · "1 day ago" · "24 days ago" — the rail's mono line. */
export function formatAge(days: number): string {
  if (days === 0) return "today";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
