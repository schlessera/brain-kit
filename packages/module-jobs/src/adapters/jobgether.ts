import { BaseAdapter } from "./base.js";
import type { RawJob, ScrapeOptions } from "../types.js";

/**
 * Jobgether, through the JSON surface its own robots.txt points a crawler at.
 *
 * The five `/remote-jobs/<location>/<category>` pages this adapter used to
 * scrape answer HTTP 410; the site moved to `/search-offers`, and `?page=N`
 * there was client-side and served byte-identical markup, so paginating it
 * only burned requests. The postings are published as JSON instead, at
 * `/api/v1/jobs`, with the title, company, URL, location, contract type and
 * salary the HTML was being scraped for and an ISO `postedAt`.
 *
 * One request, no pagination. A GET pages through `?page=`/`?limit=` and
 * nothing else (a POST body can page too, which is the route
 * docs/decisions/scraping-politeness.md rules out), and robots.txt disallows `/*?*` for every path but the
 * deprecated `/astroapi/ai/jobs.json` alias, which the site's own docs retire
 * on 2026-09-28. So a run takes the first page of the unqualified path and
 * stops; widening it means asking the site for permission, not adding a loop.
 */
const API_URL = "https://jobgether.com/api/v1/jobs";

/**
 * The site asks for `Crawl-delay: 2`, but places the line above its
 * `User-agent: *` group, where no parser will attribute it. Honour it here.
 */
const CRAWL_DELAY_MS = 2000;

/** One record of `/api/v1/jobs`; every field is optional on the wire. */
interface JobgetherOffer {
  id?: string;
  title?: string;
  company?: string;
  url?: string;
  location?: string;
  remote?: string;
  contractType?: string;
  experience?: string;
  salaryRange?: string;
  jobFunctions?: string[];
  postedAt?: string;
}

interface JobgetherResponse {
  jobs?: JobgetherOffer[];
}

/** `"70000-90000 USD"` → the pieces `RawJob` stores separately. */
function parseSalaryRange(raw: string | undefined): {
  min?: number;
  max?: number;
  currency?: string;
} {
  if (!raw) return {};
  const match = raw.match(/^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})\s*$/);
  if (!match) return {};
  const min = Number(match[1]) > 0 ? Number(match[1]) : undefined;
  const max = Number(match[2]) > 0 ? Number(match[2]) : undefined;
  // A currency with no amount behind it is not a salary, so `0-0 EUR` maps to
  // nothing rather than to a bare "EUR".
  if (min === undefined && max === undefined) return {};
  return { min, max, currency: match[3] };
}

function mapRemoteType(remote: string | undefined): RawJob["remote_type"] {
  const value = (remote ?? "").toLowerCase();
  if (value.includes("hybrid")) return "hybrid";
  if (value.includes("remote")) return "fully_remote";
  return "unknown";
}

function mapJobType(contractType: string | undefined): RawJob["job_type"] {
  const value = (contractType ?? "").toLowerCase();
  if (value.includes("part")) return "part_time";
  if (value.includes("fixed") || value.includes("freelance") || value.includes("contract")) {
    return "contract";
  }
  if (value.includes("full")) return "full_time";
  return undefined;
}

export class JobgetherAdapter extends BaseAdapter {
  readonly source = "jobgether" as const;
  readonly name = "Jobgether";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const pages = this.ledger();
    const jobs: RawJob[] = [];

    try {
      if (opts.verbose) console.log(`[jobgether] Fetching: ${API_URL}...`);

      // One page per run: robots.txt wins over POST paging (docs/decisions/scraping-politeness.md).
      const data = await this.http.getJson<JobgetherResponse>(API_URL, {
        delayMs: CRAWL_DELAY_MS,
        proxy: opts.proxy,
      });

      // An envelope carrying a `jobs` array with nothing in it is the API
      // saying it has no offers today; a body with no `jobs` array at all is
      // not this endpoint's answer, and the ledger reports that as drift.
      const envelope = Array.isArray(data?.jobs);
      const offers = envelope ? data.jobs! : [];

      // A record that cannot name its own employer is not a job posting; drop
      // it and say which field was missing rather than storing "Unknown".
      const missing = { title: 0, company: 0, url: 0 };

      for (const offer of offers) {
        const title = offer.title?.trim() ?? "";
        const company = offer.company?.trim() ?? "";
        const url = offer.url?.trim() ?? "";
        if (!title) missing.title++;
        if (!company) missing.company++;
        if (!url) missing.url++;
        if (!title || !company || !url) continue;

        const salary = parseSalaryRange(offer.salaryRange);

        jobs.push({
          source: "jobgether",
          source_id: offer.id?.trim() || url,
          title,
          company,
          url,
          source_url: url,
          location: offer.location?.trim() || "Remote",
          remote_type: mapRemoteType(offer.remote),
          job_type: mapJobType(offer.contractType),
          tags: offer.jobFunctions?.length ? offer.jobFunctions : undefined,
          salary_min: salary.min,
          salary_max: salary.max,
          salary_currency: salary.currency,
          salary_raw: offer.salaryRange?.trim() || undefined,
          published_at: offer.postedAt,
        });
      }

      for (const [field, count] of Object.entries(missing)) {
        if (count > 0) pages.note(`Jobgether: ${count} offer(s) carried no ${field}`);
      }
      pages.read(API_URL, jobs.length, { declaredEmpty: envelope && offers.length === 0 });

      if (opts.verbose) console.log(`[jobgether] Found ${jobs.length} jobs`);
    } catch (err) {
      pages.unreachable(API_URL, err);
    }

    return this.makeResult(jobs, pages);
  }
}
