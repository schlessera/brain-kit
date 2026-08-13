import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import { mapLimit } from "../concurrency.js";
import { decodeEntities, findJsonLdType, stripHtml } from "../html.js";
import { applyJobPosting } from "../jsonld-job.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// remotely.de — German board, English-language jobs included.
//
// The previous adapter matched no jobs at all and its link fallback swept up
// the site navigation instead, so every row it ever stored was a category or
// pagination link ("seite/2" titled "Weiter", "bereich/engineering" titled
// "Engineering") rather than a posting. Three reasons:
//   1. The listing's JSON-LD is a CollectionPage → ItemList whose entries are
//      bare {@id, name} pairs with no "@type": "JobPosting", so the type check
//      never matched.
//   2. Job URLs are /job/{slug}, not /remote-jobs/{slug} as the fallback
//      assumed — which is exactly why it only ever caught navigation.
//   3. The apex domain 301s to www.
//
// Job links are now taken from the listing markup and filtered to /job/, and
// each posting's own page supplies a complete JobPosting block.
const BASE_URL = "https://www.remotely.de/remote-jobs";
const PAGES_TO_FETCH = 5;

const DETAIL_CONCURRENCY = 3;
const MAX_DETAILS_PER_RUN = 100;

export class RemotelyDeAdapter extends BaseAdapter {
  readonly source = "remotelyde" as const;
  readonly name = "Remotely.de";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const slugs = new Map<string, string>(); // slug -> title from the listing

    for (let page = 1; page <= PAGES_TO_FETCH; page++) {
      try {
        const url = page === 1 ? BASE_URL : `${BASE_URL}/seite/${page}`;
        if (opts.verbose) console.log(`[remotelyde] Fetching page ${page}...`);

        const html = await httpGetText(url, { rateLimit: 2000, proxy: opts.proxy });
        const pageSlugs = this.parseListings(html);
        if (pageSlugs.size === 0) break; // past the last page

        for (const [slug, title] of pageSlugs) {
          if (!slugs.has(slug)) slugs.set(slug, title);
        }
      } catch (err) {
        errors.push(`remotely.de page ${page} failed: ${err}`);
        break;
      }
    }

    if (slugs.size === 0) {
      errors.push("remotely.de listing yielded 0 jobs — markup drift?");
      return this.makeResult([], errors);
    }

    let queue = [...slugs.entries()];
    if (queue.length > MAX_DETAILS_PER_RUN) {
      const dropped = queue.length - MAX_DETAILS_PER_RUN;
      errors.push(
        `remotely.de: capped detail fetches at ${MAX_DETAILS_PER_RUN}, ${dropped} job(s) kept without description`
      );
      queue = queue.slice(0, MAX_DETAILS_PER_RUN);
    }
    const listingOnly = [...slugs.entries()].slice(queue.length);

    if (opts.verbose) console.log(`[remotelyde] Fetching ${queue.length} detail pages...`);

    let enriched = 0;
    const detailed = await mapLimit(queue, DETAIL_CONCURRENCY, async ([slug, title]) => {
      const base = this.listingStub(slug, title);
      try {
        const html = await httpGetText(this.jobUrl(slug), { rateLimit: 250, proxy: opts.proxy });
        const posting = findJsonLdType(html, "JobPosting");
        if (posting) {
          enriched++;
          return applyJobPosting(base, posting);
        }
        // Expired and sponsored placeholder pages ship only a BreadcrumbList.
        // They still name the employer in the document title, which beats
        // storing "Unknown".
        return this.fromTitleTag(base, html);
      } catch {
        // Keep the listing-level record.
      }
      return base;
    });

    const collected = [
      ...detailed.filter((j): j is RawJob => j !== null),
      ...listingOnly.map(([slug, title]) => this.listingStub(slug, title)),
    ];

    // A job whose listing title was unusable and whose detail page did not load
    // has no title at all; storing it would recreate the junk rows this rewrite
    // exists to remove.
    const jobs = collected.filter((j) => j.title.length > 0);
    const untitled = collected.length - jobs.length;

    if (enriched < queue.length) {
      errors.push(
        `remotely.de: ${queue.length - enriched} of ${queue.length} job(s) stored without a description (detail fetch or JobPosting missing)`
      );
    }
    if (untitled > 0) {
      errors.push(`remotely.de: dropped ${untitled} job(s) with no resolvable title`);
    }

    if (opts.verbose) {
      console.log(`[remotelyde] Total: ${jobs.length} jobs (${enriched} with description)`);
    }
    return this.makeResult(jobs, errors);
  }

  /**
   * Collect `/job/{slug}` links. Anything else under the site root — /firma/,
   * /bereich/, /remote-jobs/seite/ — is navigation, and treating it as a job is
   * the bug this adapter is being rescued from.
   */
  private parseListings(html: string): Map<string, string> {
    const found = new Map<string, string>();

    // The CollectionPage → ItemList block is the authoritative title source:
    // its {@id, name} pairs hold exactly the job title. Take it first.
    const collection = findJsonLdType(html, "CollectionPage");
    const items = collection?.mainEntity?.itemListElement;
    if (Array.isArray(items)) {
      for (const entry of items) {
        const item = entry?.item ?? entry;
        const id: string | undefined = item?.["@id"] ?? item?.url;
        const name: string | undefined = item?.name;
        if (!id || !name) continue;
        const slugMatch = id.match(/\/job\/([a-z0-9-]+)/i);
        if (slugMatch) found.set(slugMatch[1], decodeEntities(name));
      }
    }

    // Anchors cover the jobs the ItemList omits. Their text can run past the
    // heading into the card's teaser copy, so anything implausibly long is
    // treated as no title at all rather than stored as a sentence — the detail
    // page's JobPosting supplies the real one during enrichment.
    const linkRe = /<a[^>]*href="(?:https:\/\/www\.remotely\.de)?\/job\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(html)) !== null) {
      const [, slug, inner] = match;
      if (!slug || found.has(slug)) continue;
      const title = decodeEntities(stripHtml(inner)).trim();
      found.set(slug, title.length > 0 && title.length <= 150 ? title : "");
    }

    return found;
  }

  private jobUrl(slug: string): string {
    return `https://www.remotely.de/job/${slug}`;
  }

  /**
   * Recover title and employer from `<title>{job} bei {company} | remotely.de</title>`
   * when the page carries no JobPosting block.
   */
  private fromTitleTag(base: RawJob, html: string): RawJob {
    const tag = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (!tag) return base;

    const text = decodeEntities(stripHtml(tag[1])).replace(/\s*\|\s*remotely\.de\s*$/i, "").trim();
    if (!text) return base;

    const split = text.match(/^(.*?)\s+bei\s+(.+)$/);
    if (!split) return base.title ? base : { ...base, title: text };

    const [, jobTitle, company] = split;
    return {
      ...base,
      title: base.title || jobTitle.trim(),
      company: company.trim() || base.company,
    };
  }

  private listingStub(slug: string, title: string): RawJob {
    const url = this.jobUrl(slug);
    return {
      source: "remotelyde",
      source_id: url,
      title,
      company: "Unknown",
      url,
      source_url: url,
      location: "Germany (Remote)",
      remote_type: "fully_remote",
      job_type: "full_time",
    };
  }
}
