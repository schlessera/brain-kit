/**
 * Shared schema.org JobPosting → RawJob mapping.
 *
 * Dice, NoDesk and Jobgether all publish a standard JobPosting block on their
 * detail pages, so the field-by-field interpretation (employment type, the two
 * shapes of baseSalary, remote detection) lives here once instead of being
 * re-derived — and re-bugged — per adapter.
 */

import { decodeEntities } from "./html.js";
import { ANNUALIZED_MARKER, parseSalaryRange } from "./salary.js";
import type { RawJob } from "./types.js";

/**
 * Normalize a JSON-LD date to ISO-8601.
 *
 * Boards are inconsistent here: Dice emits proper ISO, while Jobgether ships a
 * JavaScript `Date.toString()` ("Wed Aug 12 2026 23:30:27 GMT+0000 (…)"). Every
 * other source in the pipeline stores ISO, and date columns are compared and
 * sorted as text, so a stray non-ISO value silently sorts wrong. Unparseable
 * input is dropped rather than stored in a format nothing else understands.
 */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  // Already ISO-ish (starts with YYYY-MM-DD) — keep the source's own precision.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function organizationName(data: Record<string, any>): string | undefined {
  const org = data.hiringOrganization;
  const name = typeof org === "string" ? org : org?.name;
  return name ? decodeEntities(String(name)) : undefined;
}

export function employmentToJobType(
  employmentType: unknown
): RawJob["job_type"] | undefined {
  const value = Array.isArray(employmentType)
    ? employmentType.join(" ")
    : String(employmentType ?? "");
  const normalized = value.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("contract") || normalized.includes("freelance")) return "contract";
  if (normalized.includes("part")) return "part_time";
  if (normalized.includes("intern") || normalized.includes("temp")) return "contract";
  if (normalized.includes("full")) return "full_time";
  return undefined;
}

export interface ParsedSalary {
  min?: number;
  max?: number;
  raw?: string;
  currency?: string;
}

/**
 * `baseSalary.value` appears in two forms: a MonetaryAmount/QuantitativeValue
 * object carrying minValue/maxValue, or free text such as "Depends on
 * Experience". Only the former yields numbers; the latter is preserved raw so
 * the reviewer still sees what the board said.
 */
export function parseJsonLdSalary(data: Record<string, any>): ParsedSalary {
  const node = data.baseSalary?.value;
  const currency = data.baseSalary?.currency;

  if (node && typeof node === "object") {
    const min = Number(node.minValue);
    const max = Number(node.maxValue);
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    if (!hasMin && !hasMax) return {};

    let rawMin = hasMin ? min : undefined;
    let rawMax = hasMax ? max : undefined;
    let raw = [rawMin, rawMax].filter((v) => v !== undefined).join("-");

    // Hourly/daily/weekly/monthly rates must be annualized to be comparable
    // with the annual figures every other source reports.
    const unit = String(node.unitText ?? "").toUpperCase();
    const multiplier =
      unit === "HOUR" ? 2080 : unit === "DAY" ? 260 : unit === "WEEK" ? 52 : unit === "MONTH" ? 12 : 1;
    if (multiplier !== 1) {
      if (rawMin !== undefined) rawMin = Math.round(rawMin * multiplier);
      if (rawMax !== undefined) rawMax = Math.round(rawMax * multiplier);
      raw = `${raw} ${ANNUALIZED_MARKER}`;
    }

    return { min: rawMin, max: rawMax, raw, currency };
  }

  if (typeof node === "string" && node.trim()) {
    const text = node.trim();
    const parsed = parseSalaryRange(text);
    if (parsed.min !== undefined && parsed.max !== undefined) {
      return {
        min: parsed.min,
        max: parsed.max,
        raw: parsed.annualizedFromHourly ? `${text} ${ANNUALIZED_MARKER}` : text,
        currency,
      };
    }
    // Non-numeric text ("Depends on Experience") — keep it, but claim no
    // currency, since there is no amount for it to qualify.
    return { raw: text };
  }

  return {};
}

/**
 * Overlay a JobPosting onto an existing RawJob. Listing-derived values are kept
 * whenever the structured data has nothing better to say, so enrichment can
 * only add information, never blank out a field we already had.
 */
export function applyJobPosting(base: RawJob, data: Record<string, any>): RawJob {
  const salary = parseJsonLdSalary(data);
  const company = organizationName(data);
  const jobType = employmentToJobType(data.employmentType);
  const remote = data.jobLocationType === "TELECOMMUTE";

  const location =
    data.jobLocation?.address?.addressLocality ||
    data.applicantLocationRequirements?.name ||
    base.location ||
    (remote ? "Remote" : undefined);

  return {
    ...base,
    title: data.title ? decodeEntities(String(data.title)) : base.title,
    company: company || base.company,
    description:
      typeof data.description === "string" && data.description.trim()
        ? data.description
        : base.description,
    location,
    remote_type: remote ? "fully_remote" : base.remote_type,
    job_type: jobType ?? base.job_type,
    salary_min: salary.min ?? base.salary_min,
    salary_max: salary.max ?? base.salary_max,
    salary_raw: salary.raw ?? base.salary_raw,
    salary_currency:
      salary.min !== undefined || salary.max !== undefined
        ? salary.currency || base.salary_currency
        : base.salary_currency,
    published_at: toIsoDate(data.datePosted) || base.published_at,
    expires_at: toIsoDate(data.validThrough) || base.expires_at,
  };
}
