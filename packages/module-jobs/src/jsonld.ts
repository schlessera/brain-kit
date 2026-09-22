/**
 * Schema.org `JobPosting` → `RawJob`, in one place.
 *
 * The extraction half of this is generic and lives in
 * `@schlessera/brain-scrape`; what is here is the part that is actually about
 * jobs, and it stays here because the scraping base is deliberately ignorant
 * of what it is scraping (`packages/scrape/src/adapter/types.ts`).
 *
 * It replaces a copy that lived on one adapter. Every board that publishes
 * structured data publishes the same vocabulary, so the employment-type
 * spellings, the two `baseSalary` shapes and the date handling below are not
 * remotely.de's business — they are the vocabulary's.
 *
 * What it will not do is invent. A listing whose `ItemList` carries a name and
 * a URL and nothing else is a REFERENCE to a job, not a job: it has no
 * company, no salary and (on remotely.de) no description, and the only way to
 * get those is the detail page. So references come back separately from
 * postings, and an adapter decides what to do with them.
 */
import {
  extractJsonLd,
  itemListEntries,
  jsonLdByType,
  stripHtml,
  type JsonLdNode,
} from "@schlessera/brain-scrape";

import { ANNUALIZED_MARKER, HOURS_PER_YEAR } from "./salary.js";
import type { RawJob, Source } from "./types.js";

/** What every adapter in this repo stores when a board names no employer. */
const UNKNOWN_COMPANY = "Unknown";

/**
 * Pay period → how many of them are in a year.
 *
 * HOUR is `salary.ts`'s `HOURS_PER_YEAR` (2080 = 40 hours x 52 weeks) so a
 * figure annualized out of structured data and one annualized out of a salary
 * string are the same number rather than two conventions. The rest are that
 * same year seen through a different unit: 52 weeks of 40 hours, 260 working
 * days of 8, 12 months.
 */
const PERIODS_PER_YEAR: Record<string, number> = {
  HOUR: HOURS_PER_YEAR,
  DAY: HOURS_PER_YEAR / 8,
  WEEK: HOURS_PER_YEAR / 40,
  MONTH: 12,
  YEAR: 1,
};

/** Dates outside this range are a parse accident, not a publication date. */
const PLAUSIBLE_YEARS = { min: 1990, max: 2100 };

/** Board-specific knowledge the mapper is given rather than guesses. */
export interface JobPostingMapOptions {
  /** Which board this came from. */
  source: Source;
  /** The page the JSON-LD was served on; relative URLs resolve against it. */
  pageUrl?: string;
  /** Location to record when the posting names none. */
  defaultLocation?: string;
  /** Currency to assume when `baseSalary` names none. */
  defaultCurrency?: string;
}

/**
 * A job the listing points at but does not describe.
 *
 * `ItemList` entries carry a title and a URL; Built In adds a description,
 * remotely.de does not. Nothing here is enough to store a row on its own —
 * there is no company — which is exactly what makes it a reference.
 */
export interface JobReference {
  title: string;
  url?: string;
  description?: string;
}

export interface JsonLdJobs {
  /** Complete `JobPosting` nodes, mapped. */
  jobs: RawJob[];
  /** `ItemList` entries that name a job without describing one. */
  references: JobReference[];
  /** One per script tag that did not parse. */
  errors: string[];
}

/** First usable string out of a value schema.org allows to be almost anything. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = text(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    return text((value as JsonLdNode).name);
  }
  return undefined;
}

/** Every usable string in a value that may be one thing or a list of them. */
function texts(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    const found = text(entry);
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

/**
 * A figure, or nothing.
 *
 * `Number("")` is 0, so an empty string has to be refused before conversion —
 * a board that serves the key with nothing in it would otherwise be read as
 * publishing a salary of zero.
 */
function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const digits = value.replace(/[,\s]/g, "");
    if (!digits) return undefined;
    const parsed = Number(digits);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * The board's own id for a posting — never the label printed beside it.
 *
 * `identifier` is a bare string on some boards and a `PropertyValue` on others,
 * where the id is in `value` and `name` is a human label. Dice's label is the
 * COMPANY, so reading the wrong half of that pair gives every posting by one
 * employer the same `source_id` and the run stores one of them. The list form
 * is allowed too, which is why this recurses rather than reading `.name`.
 */
function identifierValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return text(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = identifierValue(entry);
      if (found) return found;
    }
    return undefined;
  }
  const property = node(value);
  return property ? text(property.value) : undefined;
}

function node(value: unknown): JsonLdNode | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonLdNode;
}

/**
 * A publication date that is safe to store.
 *
 * `published_at` and `expires_at` are read as ISO-8601 by everything
 * downstream, so a value that is not ISO is converted or dropped — never
 * passed through to be mistaken for one. Jobgether serves `datePosted` as a
 * JavaScript `Date.toString()` ("Tue Sep 22 2026 11:31:21 GMT+0000
 * (Coordinated Universal Time)"), which is still true on its offer pages;
 * anything `Date` can read becomes the instant it names.
 *
 * A date with no time — "2026-09-18", which NoDesk and Ashby serve — is left
 * exactly as it is. It is already ISO, and expanding it would assert a
 * midnight the board never stated.
 */
export function normalizeJsonLdDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return undefined;
  const year = parsed.getUTCFullYear();
  if (year < PLAUSIBLE_YEARS.min || year > PLAUSIBLE_YEARS.max) return undefined;
  return parsed.toISOString();
}

/**
 * Employment type, in whichever of its spellings a board chose.
 *
 * Schema.org's own list is upper snake case, boards serve it as a string or as
 * an array of them, and German boards serve German. Anything outside the three
 * `RawJob` buckets — an internship, a volunteer post — is left unset rather
 * than rounded into one of them.
 */
export function mapEmploymentType(value: unknown): RawJob["job_type"] | undefined {
  for (const entry of texts(value)) {
    const token = entry.toLowerCase();
    if (/contract|freelance|temporary|befristet/.test(token)) return "contract";
    if (/part[\s_-]?time|teilzeit/.test(token)) return "part_time";
    if (/full[\s_-]?time|vollzeit|permanent/.test(token)) return "full_time";
  }
  return undefined;
}

export interface MappedSalary {
  min?: number;
  max?: number;
  currency?: string;
  /** The figures as the board stated them, period included. */
  raw?: string;
}

/**
 * `baseSalary`, in both the shapes schema.org documents.
 *
 * The full one is a `MonetaryAmount` whose `value` is a `QuantitativeValue`
 * carrying `minValue`/`maxValue` (NoDesk, SimplyHired, Jobgether) or a single
 * `value`; the short one puts the number straight on the `MonetaryAmount`
 * (Dice). Both describe the same thing and both come out the same here.
 *
 * A rate that is not annual is annualized through `PERIODS_PER_YEAR`, so
 * boards quoting hourly and boards quoting yearly stay comparable — which is
 * what the compensation dimension of the score reads. A figure with no
 * `unitText` is taken as annual: it is what every board observed without one
 * means, and the alternative is discarding the only salary they publish.
 */
export function mapBaseSalary(posting: JsonLdNode, defaultCurrency?: string): MappedSalary {
  const salary = node(posting.baseSalary);
  const flat = numeric(posting.baseSalary);
  if (!salary && flat === undefined) return {};

  const amount = salary ? (node(salary.value) ?? salary) : undefined;
  // The currency belongs on the MonetaryAmount, but boards have put it on the
  // nested QuantitativeValue, so the inner one wins where both exist.
  const currency =
    text(amount?.currency) ??
    text(amount?.currencyCode) ??
    text(salary?.currency) ??
    text(salary?.currencyCode) ??
    text(posting.salaryCurrency) ??
    defaultCurrency;

  // A figure of zero or less is a placeholder, not pay.
  const figure = (value: unknown) => {
    const parsed = numeric(value);
    return parsed !== undefined && parsed > 0 ? parsed : undefined;
  };
  const point = amount ? figure(amount.value) : figure(posting.baseSalary);
  const min = (amount ? figure(amount.minValue) : undefined) ?? point;
  const max = (amount ? figure(amount.maxValue) : undefined) ?? point;
  if (min === undefined && max === undefined) return { currency };

  // A unit outside the five schema.org documents is left un-annualized rather
  // than guessed at, and `raw` keeps it visible to whoever reviews the row.
  const unit = (amount ? text(amount.unitText) : undefined)?.toUpperCase() ?? "YEAR";
  const factor = PERIODS_PER_YEAR[unit];
  const annualize = (figure?: number) =>
    figure === undefined || factor === undefined ? figure : Math.round(figure * factor);

  const stated = min === max ? `${min}` : `${min ?? "?"}-${max ?? "?"}`;
  const raw = `${stated}${currency ? ` ${currency}` : ""}/${unit}${
    unit === "HOUR" ? ` ${ANNUALIZED_MARKER}` : ""
  }`;

  return { min: annualize(min), max: annualize(max), currency, raw };
}

/** Where the work is, said in whichever field the board said it in. */
function mapLocation(posting: JsonLdNode, fallback?: string): string | undefined {
  const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  const named: string[] = [];
  for (const place of places) {
    const address = node(node(place)?.address);
    if (!address) continue;
    const name =
      text(address.addressLocality) ??
      text(address.addressRegion) ??
      text(address.addressCountry);
    if (name && !named.includes(name)) named.push(name);
  }
  if (named.length > 0) return named.join(", ");

  // A fully remote posting often has no `jobLocation` at all — where it may be
  // done from is the only geography it states.
  const allowed = texts(posting.applicantLocationRequirements);
  if (allowed.length > 0) return allowed.join(", ");

  return fallback;
}

/** Absolutize a URL the posting gave, when the page it came from is known. */
function resolve(href: string | undefined, pageUrl?: string): string | undefined {
  if (!href) return undefined;
  if (!pageUrl) return href;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

/**
 * One `JobPosting` node.
 *
 * Returns null for a node with no title: `ingestJobs` drops a row with no
 * title anyway, and a titleless posting is a page fragment rather than a job.
 */
export function mapJobPosting(posting: JsonLdNode, opts: JobPostingMapOptions): RawJob | null {
  const title = text(posting.title) ?? text(posting.name);
  if (!title) return null;

  const company = text(node(posting.hiringOrganization)?.name) ?? UNKNOWN_COMPANY;
  const url = resolve(text(posting.url) ?? text(posting["@id"]), opts.pageUrl);

  const sourceId = identifierValue(posting.identifier) ?? url ?? `${company}::${title}`;

  const salary = mapBaseSalary(posting, opts.defaultCurrency);
  const description = text(posting.description);

  // `jobLocationType` is schema.org's own remote flag; a posting that lists
  // where applicants may be located instead is saying the same thing in the
  // only other place the vocabulary offers.
  const remote =
    texts(posting.jobLocationType).some((entry) => entry.toUpperCase() === "TELECOMMUTE") ||
    texts(posting.applicantLocationRequirements).length > 0;

  return {
    source: opts.source,
    source_id: sourceId,
    title,
    company,
    description: description ? stripHtml(description) : undefined,
    url,
    source_url: url,
    location: mapLocation(posting, opts.defaultLocation),
    remote_type: remote ? "fully_remote" : "unknown",
    job_type: mapEmploymentType(posting.employmentType),
    salary_min: salary.min,
    salary_max: salary.max,
    salary_currency: salary.currency,
    salary_raw: salary.raw,
    published_at: normalizeJsonLdDate(posting.datePosted),
    expires_at: normalizeJsonLdDate(posting.validThrough),
  };
}

/**
 * The jobs an `ItemList` points at.
 *
 * Only `ItemList` — a `BreadcrumbList` is the same `ListItem`-of-`{@id, name}`
 * shape carrying the site's navigation, and remotely.de and Jobgether both
 * serve one next to the posting they describe.
 */
export function listingReferences(documents: unknown, pageUrl?: string): JobReference[] {
  const references: JobReference[] = [];
  const seen = new Set<string>();

  for (const list of jsonLdByType(documents, "ItemList")) {
    for (const entry of itemListEntries(list)) {
      const title = text(entry.name) ?? text(entry.title);
      const url = resolve(text(entry.url) ?? text(entry["@id"]), pageUrl);
      if (!title || !url) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const description = text(entry.description);
      references.push({
        title,
        url,
        description: description ? stripHtml(description) : undefined,
      });
    }
  }

  return references;
}

/**
 * Everything a page's structured data has to say about jobs.
 *
 * Postings and references are kept apart because they are not the same claim:
 * a posting is a row, a reference is a URL worth fetching. An adapter that
 * only has references decides for itself whether a title and a link are worth
 * storing.
 */
export function jobsFromJsonLd(html: string, opts: JobPostingMapOptions): JsonLdJobs {
  const { documents, errors } = extractJsonLd(html);

  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  for (const posting of jsonLdByType(documents, "JobPosting")) {
    const job = mapJobPosting(posting, opts);
    if (!job || seen.has(job.source_id)) continue;
    seen.add(job.source_id);
    jobs.push(job);
  }

  return { jobs, references: listingReferences(documents, opts.pageUrl), errors };
}
