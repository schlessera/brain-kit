/**
 * Browser-based scraper for sites that require JS execution (Cloudflare,
 * client-rendered). Uses headless Chrome via the Chrome DevTools Protocol
 * (raw CDP over WebSocket — no Playwright/Puppeteer dependency).
 *
 * Prerequisites: Chrome running with --remote-debugging-port=9222
 *   google-chrome --remote-debugging-port=9222 --no-first-run --headless=new
 */

import { Database } from "bun:sqlite";
import { openDatabase, logScrapeRun } from "./db";
import { computeFingerprint, normalizeCompany, normalizeTitle, runDedup } from "./dedup";
import { scoreNewJobs, autoClassify, type ScoringConfig } from "./score";
import { ANNUALIZED_MARKER, parseSalaryRange } from "./salary";
import type { RawJob, Source } from "./types";
import { EUR_RATES } from "./types";
import { stripHtml } from "./html";

interface BrowserSite {
  source: Source;
  urls: string[];
  readySelector: string;
  extractor: string;
}

// Neutral default search terms for the query-driven browser board (dice).
const DEFAULT_QUERIES = ["software engineer", "backend engineer", "platform engineer"];

/**
 * Sites that need browser scraping and their configs. `readySelector` is
 * polled (with document readiness) before extraction. Dice search URLs are
 * built from the caller's `queries`.
 */
function buildBrowserSites(queries: string[]): Record<string, BrowserSite> {
  const q = queries.length > 0 ? queries : DEFAULT_QUERIES;
  return {
    builtin: {
      source: "builtin",
      urls: [
        "https://builtin.com/jobs/remote",
        "https://builtin.com/jobs/remote?page=1",
        "https://builtin.com/jobs/remote?page=2",
      ],
      readySelector: 'a[href*="/job/"]',
      extractor: `() => {
        const jobs = [];
        const links = document.querySelectorAll('a[href*="/job/"]');
        const seen = new Set();
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const title = link.textContent?.trim();
          if (!title || title.length < 5 || title.length > 200) continue;
          const card = link.closest('[class*="job"], [class*="card"], article, li') || link.parentElement?.parentElement?.parentElement;
          const cardText = card?.innerText || '';
          const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
          let company = '';
          for (const line of lines) {
            if (line === title) continue;
            if (line.length > 2 && line.length < 60 && !line.match(/^(Remote|Hybrid|Apply|View|Save|Easy|\\$|Posted|\\d+ )/i)) {
              company = line; break;
            }
          }
          const fullUrl = href.startsWith('http') ? href : 'https://builtin.com' + href;
          jobs.push({ title, company, href: fullUrl, location: 'Remote', remote_type: 'fully_remote' });
        }
        return jobs;
      }`,
    },
    nodesk: {
      source: "nodesk",
      urls: ["https://nodesk.co/remote-jobs/"],
      readySelector: 'a[href^="/remote-jobs/"]',
      extractor: `() => {
        const jobs = [];
        const seen = new Set();
        const skipPaths = ['collections', 'new', 'customer-support', 'design', 'engineering', 'marketing',
          'non-tech', 'operations', 'product', 'sales', 'entry-level', 'other'];
        const jobLinks = document.querySelectorAll('a[href^="/remote-jobs/"]');
        for (const link of jobLinks) {
          const href = link.getAttribute('href') || '';
          if (seen.has(href) || href === '/remote-jobs/') continue;
          const slug = href.replace('/remote-jobs/', '').replace(/\\/$/, '');
          if (!slug || slug.includes('/') || skipPaths.includes(slug) || slug.split('-').length < 3) continue;
          seen.add(href);
          const title = link.textContent?.trim();
          if (!title || title.length < 5) continue;
          let container = link.parentElement;
          for (let i = 0; i < 5 && container; i++) {
            if ((container.textContent?.length || 0) > 100) break;
            container = container.parentElement;
          }
          const companyEl = container?.querySelector('a[href*="/remote-companies/"]');
          const company = companyEl?.textContent?.trim() || '';
          const text = container?.textContent || '';
          const locMatch = text.match(/Remote:\\s*(.*?)(?:\\n|Engineering|Design|Marketing|Sales|Product|Customer|Non|Operations|Other)/s);
          const location = locMatch ? locMatch[1].replace(/[·]/g, ',').trim() : 'Remote';
          jobs.push({ title, company, href: 'https://nodesk.co' + href, location, remote_type: 'fully_remote' });
        }
        return jobs;
      }`,
    },
    dice: {
      source: "dice",
      urls: q.map(
        (query) => `https://www.dice.com/jobs?q=${encodeURIComponent(query)}&filters.isRemote=true`
      ),
      readySelector: 'a[aria-label*="View Details for"]',
      extractor: `() => {
        const jobs = [];
        const viewLinks = document.querySelectorAll('a[aria-label*="View Details for"]');
        for (const link of viewLinks) {
          const label = link.getAttribute('aria-label') || '';
          const titleMatch = label.match(/View Details for (.+?)\\s*\\([a-f0-9]+\\)$/);
          const title = titleMatch ? titleMatch[1] : '';
          const href = link.getAttribute('href') || '';
          if (!title || !href.includes('/job-detail/')) continue;
          const el = link.parentElement;
          const context = el?.parentElement?.innerText || '';
          const lines = context.split('\\n').map(l => l.trim()).filter(Boolean);
          let company = '', location = '', salary = '', empType = '';
          let foundTitle = false;
          for (const line of lines) {
            if (line.includes(title)) { foundTitle = true; continue; }
            if (!foundTitle) continue;
            if (!company && line.length > 2 && line.length < 80 &&
                !line.match(/^(Remote|Hybrid|On-site|Easy|Apply|View|Save|\\$|Posted|Today|Yesterday|Full time|Contract|Part time|Third Party|Job Description)/i)) {
              company = line; continue;
            }
            if (line.match(/\\$[\\d,]+/) && !salary) { salary = line; continue; }
            if (line.match(/^(Full time|Contract|Part time|Third Party)$/i) && !empType) { empType = line; }
          }
          jobs.push({ title, company, href, location: 'Remote', salary, empType, remote_type: 'fully_remote' });
        }
        return jobs;
      }`,
    },
  };
}

async function getPages(
  cdpUrl: string
): Promise<Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string }>> {
  return fetch(`${cdpUrl}/json`).then(
    (r) => r.json() as Promise<Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string }>>
  );
}

async function createPage(cdpUrl: string, url: string): Promise<string> {
  const resp = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const result = (await resp.json()) as { id: string };
  return result.id;
}

async function closePage(cdpUrl: string, pageId: string): Promise<void> {
  await fetch(`${cdpUrl}/json/close/${pageId}`);
}

async function evaluateOnPage(cdpUrl: string, pageId: string, expression: string): Promise<any> {
  const pages = await getPages(cdpUrl);
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`Page ${pageId} not found`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);

  return new Promise<any>((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: `(${expression})()`,
            returnByValue: true,
            awaitPromise: true,
          },
        })
      );
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string);
      if (data.id === id) {
        ws.close();
        if (data.error) reject(new Error(data.error.message));
        else if (data.result?.exceptionDetails)
          reject(new Error(data.result.exceptionDetails.text));
        else resolve(data.result?.result?.value);
      }
    };
    ws.onerror = (err) => { ws.close(); reject(err); };
    setTimeout(() => { ws.close(); reject(new Error("Evaluate timeout")); }, 30000);
  });
}

/**
 * Poll for document readiness + presence of the target selector, up to
 * `timeoutMs`. Covers slow loads and Cloudflare challenge pages without a
 * fixed sleep. Returns false on timeout (extraction is still attempted).
 */
async function waitForPageReady(
  cdpUrl: string,
  pageId: string,
  selector: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const check = `() => document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(selector)})`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluateOnPage(cdpUrl, pageId, check)) return true;
    } catch {
      // Page may not be attachable yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function scrapeSite(
  cdpUrl: string,
  siteName: string,
  config: BrowserSite,
  verbose: boolean
): Promise<{ jobs: RawJob[]; errors: string[] }> {
  const allJobs: RawJob[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const url of config.urls) {
    try {
      if (verbose) console.log(`[${siteName}] Opening: ${url}`);
      const pageId = await createPage(cdpUrl, url);

      // Wait for page load / Cloudflare challenge to resolve
      const ready = await waitForPageReady(cdpUrl, pageId, config.readySelector);
      if (!ready && verbose) {
        console.log(`[${siteName}] Selector "${config.readySelector}" not ready within timeout on ${url}`);
      }

      if (verbose) console.log(`[${siteName}] Extracting jobs...`);
      const extracted = await evaluateOnPage(cdpUrl, pageId, config.extractor);

      await closePage(cdpUrl, pageId);

      if (!Array.isArray(extracted)) {
        errors.push(`${url}: extractor returned non-array`);
        if (verbose) console.log(`[${siteName}] No jobs extracted from ${url}`);
        continue;
      }
      if (extracted.length === 0) {
        errors.push(`${url}: 0 jobs extracted — selector drift or challenge page?`);
      }

      for (const job of extracted) {
        const id = job.href || `${job.company}-${job.title}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        allJobs.push({
          source: config.source,
          source_id: id,
          title: job.title || "",
          company: job.company || "Unknown",
          url: job.href,
          source_url: job.href,
          location: job.location || "Remote",
          remote_type: job.remote_type || "fully_remote",
          job_type: job.empType?.toLowerCase().includes("contract") ? "contract" : "full_time",
          salary_raw: job.salary || undefined,
          salary_currency: job.salary ? "USD" : undefined,
        });
      }

      if (verbose) console.log(`[${siteName}] ${extracted.length} jobs from ${url}`);
    } catch (err) {
      errors.push(`${url}: ${err}`);
      console.error(`[${siteName}] Error on ${url}: ${err}`);
    }
  }

  return { jobs: allJobs, errors };
}

function ingestBrowserJobs(db: Database, jobs: RawJob[]): { newCount: number; updatedCount: number } {
  const now = new Date().toISOString();
  let newCount = 0;
  let updatedCount = 0;

  const upsert = db.prepare(`
    INSERT INTO jobs (
      source, source_id, fingerprint,
      title, title_normalized, company, company_normalized,
      description, description_text, url, source_url,
      location, remote_type, job_type, category, tags,
      salary_min, salary_max, salary_raw, salary_currency,
      published_at, expires_at, first_seen_at, last_seen_at, scraped_at
    ) VALUES (
      $source, $source_id, $fingerprint,
      $title, $title_normalized, $company, $company_normalized,
      $description, $description_text, $url, $source_url,
      $location, $remote_type, $job_type, $category, $tags,
      $salary_min, $salary_max, $salary_raw, $salary_currency,
      $published_at, $expires_at, $now, $now, $now
    )
    ON CONFLICT(source, source_id) DO UPDATE SET
      last_seen_at = $now, scraped_at = $now
  `);

  const insertFts = db.prepare(
    "INSERT INTO jobs_fts(rowid, title, company, description_text, tags) VALUES (?, ?, ?, ?, ?)"
  );

  const transaction = db.transaction(() => {
    for (const job of jobs) {
      if (!job.source_id || !job.title) continue;
      const existing = db
        .query("SELECT id FROM jobs WHERE source = ? AND source_id = ?")
        .get(job.source, job.source_id) as { id: number } | null;

      const companyNorm = normalizeCompany(job.company);
      const titleNorm = normalizeTitle(job.title);
      const fingerprint = computeFingerprint(job.company, job.title, {
        source: job.source,
        sourceId: job.source_id,
      });

      // Parse salary (decimals handled; hourly rates annualized)
      let salaryMin: number | null = null;
      let salaryMax: number | null = null;
      let salaryRaw = job.salary_raw ?? null;
      if (job.salary_raw) {
        const parsed = parseSalaryRange(job.salary_raw);
        if (parsed.min !== undefined && parsed.max !== undefined) {
          const rate = EUR_RATES[job.salary_currency?.toUpperCase() ?? "USD"] ?? EUR_RATES.USD;
          salaryMin = Math.round(parsed.min * rate * 100);
          salaryMax = Math.round(parsed.max * rate * 100);
          if (parsed.annualizedFromHourly) salaryRaw = `${job.salary_raw} ${ANNUALIZED_MARKER}`;
        }
      }

      upsert.run({
        $source: job.source,
        $source_id: job.source_id,
        $fingerprint: fingerprint,
        $title: job.title,
        $title_normalized: titleNorm,
        $company: job.company,
        $company_normalized: companyNorm,
        $description: job.description ?? null,
        $description_text: job.description ? stripHtml(job.description) : null,
        $url: job.url ?? null,
        $source_url: job.source_url ?? null,
        $location: job.location ?? null,
        $remote_type: job.remote_type ?? "fully_remote",
        $job_type: job.job_type ?? "full_time",
        $category: null,
        $tags: null,
        $salary_min: salaryMin,
        $salary_max: salaryMax,
        $salary_raw: salaryRaw,
        $salary_currency: job.salary_currency ?? null,
        $published_at: null,
        $expires_at: null,
        $now: now,
      });

      if (existing) {
        updatedCount++;
      } else {
        newCount++;
        const newRow = db
          .query("SELECT id FROM jobs WHERE source = ? AND source_id = ?")
          .get(job.source, job.source_id) as { id: number } | null;
        if (newRow) insertFts.run(newRow.id, job.title, job.company, null, null);
      }
    }
  });

  transaction();
  return { newCount, updatedCount };
}

/**
 * Scrape the browser-requiring boards. Requires a Chrome instance listening on
 * `cdpUrl` (default http://127.0.0.1:9222). Scoring/classification runs only
 * when a parsed `scoringConfig` is supplied.
 */
export async function scrapeSites(opts: {
  dbPath: string;
  scoringConfig?: ScoringConfig | null;
  verbose?: boolean;
  cdpUrl?: string;
  sites?: string[];
  queries?: string[];
}): Promise<Array<{ source: string; found: number; newJobs: number }>> {
  const cdpUrl = opts.cdpUrl || process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
  const verbose = opts.verbose ?? false;
  const browserSites = buildBrowserSites(opts.queries ?? []);
  const sites = opts.sites ?? Object.keys(browserSites);
  const results: Array<{ source: string; found: number; newJobs: number }> = [];

  const db = openDatabase(opts.dbPath);

  for (const site of sites) {
    const config = browserSites[site];
    if (!config) continue;

    logScrapeRun(db, config.source, "running");
    const { jobs, errors } = await scrapeSite(cdpUrl, site, config, verbose);

    if (jobs.length === 0) {
      // 0 extracted jobs is an error condition, not a quiet success —
      // selector drift and challenge pages both produce empty extractions.
      const error =
        errors.length > 0
          ? errors.join("; ")
          : "0 jobs extracted — selector drift or challenge page?";
      logScrapeRun(db, config.source, "failed", { jobs_found: 0, error });
      results.push({ source: site, found: 0, newJobs: 0 });
      continue;
    }

    const { newCount, updatedCount } = ingestBrowserJobs(db, jobs);
    logScrapeRun(db, config.source, "completed", {
      jobs_found: jobs.length,
      jobs_new: newCount,
      jobs_updated: updatedCount,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    });
    results.push({ source: site, found: jobs.length, newJobs: newCount });
  }

  // Post-processing across everything ingested this run.
  runDedup(db, verbose);
  if (opts.scoringConfig) {
    scoreNewJobs(db, opts.scoringConfig, verbose);
    autoClassify(db, opts.scoringConfig);
  }

  db.close();
  return results;
}
