// The pinned clock.
//
// Every date in this fixture world is derived from one constant. Nothing here
// reads the wall clock, and nothing here is locale-sensitive: dates are built
// and formatted in UTC with arithmetic, never with `toLocaleDateString`, so
// the same fixture renders the same string on a machine in Lisbon, a CI runner
// in UTC, and a screenshot job in Tokyo.
//
// The reference date is the same one `packages/core/fixtures/corpus/` pins
// (2026-07-12). The two fixture sets are otherwise independent (D18) and share
// no content -- but a repo with two different "now"s is a repo where a
// screenshot and a test disagree about what is stale, so the date is shared
// deliberately.

/** The pinned "now", as a calendar date. Inject this; never `new Date()`. */
export const REFERENCE_DATE = "2026-07-12";

/**
 * The pinned "now", as an instant: 06:40 on Ogygia, which is UTC+2 in July.
 * 06:40 because that is the hour the morning digest lands, and the digest is
 * the screen the whole world is staged for.
 */
export const REFERENCE_INSTANT = new Date("2026-07-12T06:40:00+02:00");

/** Where the owner's phone thinks it is, versus where the household is. */
export const OGYGIA_UTC_OFFSET = "+02:00";
export const ITHACA_UTC_OFFSET = "+03:00";

/**
 * The footnote every "resolves at" time in the world has to carry, because
 * the owner and the household are one hour apart and have been for years.
 */
export const TIMEZONE_FOOTNOTE = "times shown on Ogygia (UTC+2) · Ithaca is one hour ahead";

/**
 * Days since Troy fell. Ten years to the day -- the poem's own figure for the
 * return, and the number every other duration in this world is fitted to.
 *
 * The brief suggested 2,914. It does not close: the poem states seven years on
 * Ogygia (2,557 days) and a full year on Aeaea (365), which is 2,922 before a
 * single day of sailing. 3,652 lets both of those stand, and it earns the one
 * line the world most wants to say -- the war took ten years, and so has
 * coming back.
 */
export const DAYS_SINCE_TROY = 3652;

/** Years at Troy before any of the returning started. */
export const YEARS_AT_TROY = 10;

/**
 * Years since the owner last saw Ithaca: ten at Troy and ten coming back.
 * Used wherever the world says "overdue".
 */
export const YEARS_AWAY = 20;

/** Days on Ogygia, from landfall to this morning. Seven years exactly. */
export const DAYS_ON_OGYGIA = 2557;

/** Days on Aeaea. One full year, as stated in Book X. */
export const DAYS_ON_AEAEA = 365;

const MS_PER_DAY = 86_400_000;

function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** An ISO date `n` days before the reference date. */
export function daysBefore(n: number): string {
  return toISODate(Date.parse(REFERENCE_DATE) - n * MS_PER_DAY);
}

/** An ISO date `n` days after the reference date. */
export function daysAfter(n: number): string {
  return toISODate(Date.parse(REFERENCE_DATE) + n * MS_PER_DAY);
}

/**
 * Whole days from an ISO date to the reference date. Positive means the past,
 * which is the direction staleness runs.
 */
export function daysSince(iso: string): number {
  return Math.round((Date.parse(REFERENCE_DATE) - Date.parse(iso)) / MS_PER_DAY);
}

/** The day Troy fell: the voyage's day zero. */
export const TROY_FELL = daysBefore(DAYS_SINCE_TROY);

/**
 * The day the raft is due to make landfall. Book V gives the raft seventeen
 * days of open water before the storm finds it, so seventeen days is both the
 * deadline the project carries and the number the forecast is arguing about.
 */
export const RAFT_DEADLINE = daysAfter(17);
