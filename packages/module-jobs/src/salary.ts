/**
 * Salary string parsing shared by adapters and the browser-scrape ingest path.
 *
 * Handles decimals ("$60.50" must not split into 60 and 50) and hourly rates:
 * hourly figures are annualized (x 2080 hours/year) so they stay comparable
 * to the annual compensation benchmark. Callers should append the
 * ANNUALIZED_MARKER to salary_raw when `annualizedFromHourly` is true so the
 * derivation is visible in review output.
 */

export const HOURS_PER_YEAR = 2080;
export const ANNUALIZED_MARKER = "[annualized from hourly]";

const HOURLY_RE = /per\s*hour|per\s*hr\.?|hourly|\/\s*(?:hr|hour)\b/i;

export interface ParsedSalaryRange {
  min?: number;
  max?: number;
  /** True when the raw string was an hourly rate annualized via HOURS_PER_YEAR. */
  annualizedFromHourly: boolean;
}

/**
 * Extract a min/max salary range from a raw salary string.
 * Returns no values unless at least two numbers are present (a single figure
 * is ambiguous: could be min, max, or a midpoint).
 */
export function parseSalaryRange(raw: string): ParsedSalaryRange {
  const nums = raw.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return { annualizedFromHourly: false };

  let min = parseFloat(nums[0].replace(/,/g, ""));
  let max = parseFloat(nums[1].replace(/,/g, ""));

  const hourly = HOURLY_RE.test(raw);
  if (hourly) {
    min *= HOURS_PER_YEAR;
    max *= HOURS_PER_YEAR;
  }

  return { min, max, annualizedFromHourly: hourly };
}
