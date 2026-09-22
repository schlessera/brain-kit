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

/**
 * Normalise a company name the way a job board slugifies it.
 *
 * Several boards put the company in the job's own URL, which is the only
 * ground truth available without opening every posting — it is how the
 * nodesk split below is counted rather than guessed.
 */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Split the stored companies three ways against the job's own URL.
 *
 * `companyLooksReal` is a shape check and cannot tell a company that is right
 * from one belonging to the card next to it — which is exactly the nodesk
 * failure. Where the board's URL carries the company slug, it can: `matched`
 * is the company the posting's own URL agrees with, `unknown` is the literal
 * placeholder, `other` is a name that came from somewhere else. Boards whose
 * URLs are opaque ids (dice) report everything as `not_applicable`.
 */
function companyVsUrl(
  rows: Array<{ company: string; url: string | null }>
): { matched: number; unknown: number; other: number; not_applicable: number } {
  const split = { matched: 0, unknown: 0, other: 0, not_applicable: 0 };
  for (const row of rows) {
    if (row.company === "Unknown") {
      split.unknown++;
      continue;
    }
    const path = row.url ? new URL(row.url, "https://example.invalid").pathname : "";
    const slug = slugify(path);
    if (!slug || /^[-0-9a-f]{16,}$/.test(path.split("/").pop() ?? "")) {
      split.not_applicable++;
      continue;
    }
    if (slug.includes(slugify(row.company))) split.matched++;
    else split.other++;
  }
  return split;
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
 * A Chrome launcher the session drives, with two hooks the session cannot
 * offer: what a page is allowed to do, and what its main-frame response was.
 *
 * `BrowserSession.load` returns only what the extractor produced — it never
 * surfaces the HTTP status, so a 403 or a challenge page comes back looking
 * exactly like a page that rendered. A capture written with an assumed 200 on
 * it is worse than one with no status at all, because the next reader believes
 * it.
 */
function browserLauncher(options: {
  offline?: boolean;
  scripts?: boolean;
  onMainFrameStatus?: (url: string, status: number) => void;
}): () => Promise<unknown> {
  const env = resolveEnv();
  return async () => {
    const puppeteer = (await import("puppeteer-core")).default;
    const browser = env.chromeUrl
      ? await puppeteer.connect({ browserURL: env.chromeUrl })
      : await puppeteer.launch({
          executablePath: env.chromePath ?? CHROME_FALLBACKS.find((path) => existsSync(path)),
          headless: true,
          args: [
            "--disable-dev-shm-usage",
            // Every lookup fails, so nothing a captured page references can be
            // re-fetched from the site it came from.
            ...(options.offline ? ["--host-resolver-rules=MAP * ~NOTFOUND"] : []),
            ...(env.noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
          ],
        });
    // The session owns page creation, so this is the only place the hooks can
    // be attached to every page it opens.
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      if (options.scripts === false) await page.setJavaScriptEnabled(false);
      if (options.onMainFrameStatus) {
        page.on("response", (response: { url(): string; status(): number; frame(): unknown }) => {
          if (response.frame() === page.mainFrame()) {
            options.onMainFrameStatus?.(response.url(), response.status());
          }
        });
      }
      return page;
    };
    return browser;
  };
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
  const session = createBrowserSession({
    launch: browserLauncher({ offline: true, scripts: false }),
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
  // What the site actually answered, per URL, as observed on the wire.
  const observedStatus = new Map<string, number>();
  if (adapter.needsBrowser) {
    browser = createBrowserSession({
      userAgent: env.userAgent,
      launch: browserLauncher({
        onMainFrameStatus: (url, status) => observedStatus.set(url, status),
      }),
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
        // Not assumed. `browser.load` resolves on a 403 or a challenge page
        // exactly as it does on a 200, so the status comes from the response
        // hook, and a capture whose status was never seen says 0 rather than
        // wearing a number nobody observed.
        renderedPages.push({ url, status: observedStatus.get(url) ?? 0, body: html });
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
  //
  // Counted by asking the database, not by adding up `ingestJobs`'s return.
  // That function looks `existing` up per job INSIDE its loop, so two jobs an
  // adapter emitted under one key come back as `new: 1, updated: 1` — two
  // outcomes for the one row the upsert actually left behind. The whole point
  // of this column is how many rows exist.
  const dbPath = join(outDir, "measure.db");
  const db = openDatabase(dbPath);
  const stats = ingestJobs(db, jobs);
  const stored = db
    .query("SELECT title, company, description_text, url, source_id, fingerprint FROM jobs")
    .all() as Array<{
    title: string;
    company: string;
    description_text: string | null;
    url: string | null;
    source_id: string;
    fingerprint: string;
  }>;
  db.close();

  const sample = stored.slice(0, 5).map(({ title, company, description_text, url }) => ({
    title,
    company,
    description_text,
    url,
  }));
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
    stored: stored.length,
    ingest_outcomes: { new: stats.new, updated: stats.updated },
    errors,
    quality: {
      titles_ok: stored.filter((r) => titleLooksLikeAJob(r.title)).length,
      companies_ok: stored.filter((r) => companyLooksReal(r.company, r.title)).length,
      descriptions_present: stored.filter((r) => (r.description_text ?? "").trim().length > 0).length,
      // The shape check above cannot tell a right company from a neighbour's.
      company_vs_url: companyVsUrl(stored),
    },
    // Whether the adapter emitted the same posting twice. `stored` collapses a
    // repeated key through the upsert, so `found === stored === distinct` is
    // what rules out a surviving duplicate — and the gap between `found` and
    // `distinct_fingerprints` is a genuine repost, not a bug.
    distinct_source_ids: new Set(stored.map((r) => r.source_id)).size,
    distinct_fingerprints: new Set(stored.map((r) => r.fingerprint)).size,
    urls_fetched: http.captures.map((c) => ({ url: c.url, status: c.status })),
    rendered_pages: renderedPages.map((p) => p.url),
    sample,
  };

  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, sample: undefined }, null, 2));
}

await main();
