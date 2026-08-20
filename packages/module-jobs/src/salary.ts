/**
 * Salary parsing and currency normalization, shared by every adapter.
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

/**
 * Fallback conversion rates to EUR, used only to make salaries in different
 * currencies roughly comparable when filtering.
 *
 * These are STALE BY CONSTRUCTION — a published package cannot ship live
 * exchange rates, and these were last true at some point before release. They
 * are the last resort: `rates` in the module config overrides any of them, so
 * a user who cares about accuracy sets their own without waiting for a
 * release. Nothing here should ever be treated as a financial figure.
 */
export const FALLBACK_EUR_RATES: Record<string, number> = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.16,
  CHF: 1.04,
  PLN: 0.23,
  CZK: 0.041,
  SEK: 0.088,
  NOK: 0.086,
  DKK: 0.134,
  CAD: 0.67,
  AUD: 0.6,
  INR: 0.011,
  JPY: 0.0061,
  CNY: 0.13,
  KRW: 0.00067,
  BRL: 0.16,
};

/**
 * Effective rate table: the fallbacks, with any configured rate replacing the
 * shipped one. Currency codes are upper-cased so config may use either case.
 */
export function eurRates(overrides?: Record<string, number>): Record<string, number> {
  if (!overrides) return FALLBACK_EUR_RATES;
  const rates = { ...FALLBACK_EUR_RATES };
  for (const [code, rate] of Object.entries(overrides)) {
    if (Number.isFinite(rate) && rate > 0) rates[code.toUpperCase()] = rate;
  }
  return rates;
}

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
