/**
 * What each job board actually returns, measured against the live sites.
 *
 * This is the harness behind issue #33. It is NOT a test — it needs the
 * network, so nothing in `tests/` may call it — and it is not part of the
 * published package (`files` in package.json does not list `scripts`). It
 * exists so the measurement in that issue can be re-run and disagreed with
 * rather than taken on trust.
 *
 * One board per invocation, on purpose: a board that hangs or gets challenged
 * must not cost the boards measured before it.
 *
 *   bun packages/module-jobs/scripts/measure-boards.ts <source> <out-dir> [country]
 *
 * It writes, under `<out-dir>/<source>/`:
 *   raw/…         every response body the adapter saw, verbatim
 *   result.json   found / stored / errors, plus a quality read of a sample
 *
 * Vantage point matters and is recorded: a board that geo-gates or A/B-tests
 * its markup otherwise looks like a parser bug to the next reader. UTC time,
 * egress COUNTRY and User-Agent only — never an address or a host name.
 *
 * For a `needsBrowser` board the rendered capture is a SECOND page load, taken
 * after the adapter has run, so a site that rotates promoted cards does not
 * serve quite the same page twice. To get numbers that the captured page
 * actually supports, replay the extractor against it — Chrome, a local file,
 * and DNS blackholed so nothing the capture references can be re-fetched:
 *
 *   bun packages/module-jobs/scripts/measure-boards.ts --replay <source> <file.html>
 *
 * The file must end in `.html`, or Chrome serves it as plain text and the
 * extractor sees no DOM at all.
 *
 * Finally, the per-board `capture.json` records are SEALED from the bytes on
 * disk rather than typed:
 *
 *   bun packages/module-jobs/scripts/measure-boards.ts --seal <boards-dir>
 *
 * That is not the guard, though — `tests/board-fixtures.test.ts` is. A
 * generator only helps the person who remembers to run it; the test fails for
 * the one who does not.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ScrapeClient,
  createBrowserSession,
  resolveEnv,
  type BrowserSession,
  type FetchOptions,
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { getAdapter } from "../src/scrape.js";
import { openDatabase } from "../src/db.js";
import { ingestJobs } from "../src/scrape.js";
import { ALL_SOURCES, type RawJob, type Source } from "../src/types.js";

/**
 * Where Chrome is looked for when nothing configures it. Duplicated from
 * `@schlessera/brain-scrape` on purpose: the replay path launches its own
 * browser (see `replay`), and the package does not export the list.
 */
const CHROME_FALLBACKS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** The queries the shipped module config defaults to, for the two query boards. */
const DEFAULT_QUERIES = ["software engineer", "backend engineer", "platform engineer"];

/**
 * An HTTP client that keeps a copy of every response it was given.
 *
 * Teeing at `get` rather than at `getText`/`getJson` is deliberate: those two
 * read the body and THEN throw on a non-2xx, so a tee above them loses exactly
 * the responses worth keeping — jobgether's 410 and simplyhired's 403 are the
 * measurement, not noise. A robots.txt refusal still produces nothing here,
 * correctly: no request went out.
 */
class TeeingClient extends ScrapeClient {
  readonly captures: Array<{ url: string; status: number; body: string }> = [];

  override async get(url: string, opts: FetchOptions = {}): Promise<Response> {
    const response = await super.get(url, opts);
    this.captures.push({ url, status: response.status, body: await response.clone().text() });
    return response;
  }
}

function safeName(url: string, index: number, status: number): string {
  const slug = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 80);
  return `${String(index).padStart(2, "0")}-${status}-${slug}`;
}

/** Does this look like a job title rather than navigation chrome or a slug? */
function titleLooksLikeAJob(title: string): boolean {
  if (!title || title.length < 5 || title.length > 120) return false;
  if (/^(home|jobs?|browse|categories|sign in|log ?in|post a job|about|blog|companies)$/i.test(title.trim())) {
    return false;
  }
  // A title assembled out of a card's whole text — the remoteineurope failure
  // mode — reads as several sentences or repeats the company name.
  if (title.split(/\s+/).length > 14) return false;
  return true;
}

function companyLooksReal(company: string, title: string): boolean {
  if (!company) return false;
  const c = company.trim();
  if (c === "Unknown" || c.length < 2 || c.length > 60) return false;
  if (c === title) return false;
  // A location or a date where a company should be.
  if (/^(remote|worldwide|anywhere|europe|germany|usa|united states|emea|global)\b/i.test(c)) return false;
  if (/^\d/.test(c)) return false;
  return true;
}

/**
 * Rewrite every `capture.json` so its byte facts describe the committed file.
 *
 * These records were hand-maintained and drifted: nine of ten `excerpt_bytes`
 * were the length of the string BEFORE the writer normalised its trailing
 * whitespace, and `remotive/robots.txt` — the one fixture that is a complete
 * response — claimed to be 648 bytes while 640 were committed. The recorded
 * `full_response_sha256` was right the whole time; the committed copy had been
 * trimmed. A fact that is typed is a fact that rots.
 */
function seal(boardsDir: string): void {
  for (const board of readdirSync(boardsDir, { withFileTypes: true })) {
    if (!board.isDirectory()) continue;
    const recordPath = join(boardsDir, board.name, "capture.json");
    if (!existsSync(recordPath)) continue;
    const record = JSON.parse(readFileSync(recordPath, "utf-8")) as {
      captures: Array<Record<string, unknown> & { fixture: string }>;
    };
    for (const capture of record.captures) {
      const bytes = readFileSync(join(boardsDir, board.name, capture.fixture));
      capture.excerpt_bytes = bytes.byteLength;
      capture.excerpt_sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    record.captures.sort((a, b) => a.fixture.localeCompare(b.fixture));
    writeFileSync(recordPath, `${JSON.stringify(record, sortedKeys, 2)}\n`);
    console.log(`sealed ${board.name}/capture.json (${record.captures.length})`);
  }
}

/** Stable key order, so a reseal is a no-op diff. */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Run one browser board's page extractor against a local capture.
 *
 * This is how a repair is checked against a committed fixture without going
 * back to the live site — and how the fixture's own numbers were produced.
 *
 * Opening a captured page in an ordinary browser is NOT a replay of it. The
 * markup still references the site's images, stylesheets and scripts, and the
 * inline scripts a rendered capture contains will run AGAIN — a framework that
 * rehydrates can rebuild or drop the very cards being counted. So this launches
 * Chrome with every hostname resolving to nothing AND turns page scripts off.
 * `page.evaluate` still works with script execution disabled, which is what
 * makes it possible to run the extractor over a page that cannot run its own
 * code. The DOM is then exactly the bytes on disk, which is the only way the
 * replay's numbers mean anything.
 */
async function replay(source: string, file: string): Promise<void> {
  const adapter = getAdapter(source as Source);
  if (!adapter.needsBrowser) {
    console.error(`${source} is not a browser board; run it against its fixture directly`);
    process.exit(2);
  }
  const env = resolveEnv();
  const session = createBrowserSession({
    launch: async () => {
      const puppeteer = (await import("puppeteer-core")).default;
      const browser = await puppeteer.launch({
        executablePath: env.chromePath ?? CHROME_FALLBACKS.find((path) => existsSync(path)),
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          // Every lookup fails, so no subresource and no script of the
          // captured page can reach the site it came from.
          "--host-resolver-rules=MAP * ~NOTFOUND",
          ...(env.noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
        ],
      });
      // The session owns page creation, so this is where script execution gets
      // turned off for every page it opens.
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const page = await newPage();
        await page.setJavaScriptEnabled(false);
        return page;
      };
      return browser;
    },
  });
  const records = await session.load<unknown[]>({
    url: `file://${resolve(file)}`,
    extract: (adapter as unknown as { extract: () => unknown[] }).extract,
  });
  await session.close();
  console.log(JSON.stringify({ source, file, records }, null, 2));
}

async function main() {
  if (process.argv[2] === "--seal") {
    const dir = process.argv[3];
    if (!dir) {
      console.error("usage: measure-boards.ts --seal <boards-dir>");
      process.exit(2);
    }
    seal(resolve(dir));
    return;
  }

  if (process.argv[2] === "--replay") {
    const [source, file] = process.argv.slice(3);
    if (!source || !file) {
      console.error("usage: measure-boards.ts --replay <source> <file.html>");
      process.exit(2);
    }
    await replay(source, file);
    return;
  }

  const [source, outRoot, egressCountry] = process.argv.slice(2);
  if (!source || !outRoot) {
    console.error("usage: measure-boards.ts <source> <out-dir> [egress-country]");
    process.exit(2);
  }
  if (!(ALL_SOURCES as readonly string[]).includes(source)) {
    console.error(`unknown source ${source}; valid: ${ALL_SOURCES.join(", ")}`);
    process.exit(2);
  }

  const outDir = join(outRoot, source);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "raw"), { recursive: true });

  const env = resolveEnv();
  const startedAt = new Date().toISOString();
  const adapter = getAdapter(source as Source, DEFAULT_QUERIES);

  const http = new TeeingClient({ userAgent: env.userAgent, respectRobots: env.respectRobots });
  let browser: BrowserSession | undefined;
  let chromeStatus = "n/a";
  if (adapter.needsBrowser) {
    browser = createBrowserSession({
      browserUrl: env.chromeUrl,
      executablePath: env.chromePath,
      noSandbox: env.noSandbox,
      userAgent: env.userAgent,
    });
    // `createBrowserSession` launches LAZILY and never throws at construction,
    // so a try/catch around it reports nothing — the same dead branch this
    // measurement found in src/scrape.ts. Probe instead, on about:blank, which
    // needs no network.
    try {
      await browser.load({ url: "about:blank", extract: () => true });
      chromeStatus = "launched";
    } catch (e) {
      chromeStatus = `unavailable: ${(e as Error).message}`;
      browser = undefined;
    }
  }

  const ctx: ScrapeContext = { http, browser, log: (m) => console.error(m) };

  let jobs: RawJob[] = [];
  let errors: string[] = [];
  const t0 = Date.now();
  try {
    const result = await adapter.bind(ctx).scrape({ incremental: false, queries: DEFAULT_QUERIES });
    jobs = result.jobs;
    errors = result.errors;
  } catch (e) {
    errors = [`${e}`];
  }
  const durationMs = Date.now() - t0;

  // The rendered DOM is what a browser board's extractor actually saw; the
  // HTTP captures above are empty for those boards by construction.
  const renderedPages: Array<{ url: string; status: number; body: string }> = [];
  if (browser) {
    for (const url of (adapter as unknown as { urls(o: unknown): string[] }).urls({
      queries: DEFAULT_QUERIES,
    })) {
      try {
        const html = await browser.load<string>({
          url,
          settleMs: 2000,
          extract: () => document.documentElement.outerHTML,
        });
        renderedPages.push({ url, status: 200, body: html });
      } catch (e) {
        errors.push(`rendered capture ${url}: ${e}`);
      }
    }
  }
  await browser?.close();

  for (const [i, capture] of [...http.captures, ...renderedPages].entries()) {
    writeFileSync(join(outDir, "raw", `${safeName(capture.url, i, capture.status)}.txt`), capture.body);
  }

  // Stored, not just found: `ingestJobs` drops a row with no source_id, title
  // or company, which is exactly the gap #32 is about.
  const dbPath = join(outDir, "measure.db");
  const db = openDatabase(dbPath);
  const stats = ingestJobs(db, jobs);
  const stored = db
    .query("SELECT title, company, description_text, url FROM jobs")
    .all() as Array<{ title: string; company: string; description_text: string | null; url: string | null }>;
  db.close();

  const sample = stored.slice(0, 5);
  const result = {
    source,
    vantage: {
      captured_at_utc: startedAt,
      egress_country: egressCountry ?? "unrecorded",
      user_agent: env.userAgent,
      chrome: chromeStatus,
    },
    duration_ms: durationMs,
    found: jobs.length,
    stored: stats.new + stats.updated,
    errors,
    quality: {
      titles_ok: stored.filter((r) => titleLooksLikeAJob(r.title)).length,
      companies_ok: stored.filter((r) => companyLooksReal(r.company, r.title)).length,
      descriptions_present: stored.filter((r) => (r.description_text ?? "").trim().length > 0).length,
    },
    urls_fetched: http.captures.map((c) => ({ url: c.url, status: c.status })),
    rendered_pages: renderedPages.map((p) => p.url),
    sample,
  };

  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, sample: undefined }, null, 2));
}

await main();
