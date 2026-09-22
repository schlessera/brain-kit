/**
 * @schlessera/brain-scrape — the scraping base every brain-kit module that
 * fetches from the web builds on.
 *
 * What it gives a module: an HTTP client that obeys robots.txt and paces
 * itself per host, an optional headless-Chrome session for sites that only
 * exist after JavaScript runs, HTML and feed parsing, and one site-adapter
 * seam so "this site needs a browser" is a flag rather than a second
 * architecture.
 *
 * What it deliberately does not give: any knowledge of what is being scraped.
 * Job postings, articles, prices — that is the consuming module's business.
 */

// Configuration (the package's single environment chokepoint).
export { ENV_VARS, DEFAULT_USER_AGENT, resolveEnv } from "./config/env.js";
export type { EnvVarSpec, ScrapeEnv } from "./config/env.js";

// Polite HTTP.
export { ScrapeClient, parseRetryAfterMs } from "./fetch/http.js";
export type { ScrapeClientOptions, FetchOptions, FetchedPage } from "./fetch/http.js";

// Politeness primitives, exported so a caller can share one across clients.
export { RateLimiter, hostOf } from "./politeness/rate-limit.js";
export type { RateLimiterOptions, RateLimiterClock } from "./politeness/rate-limit.js";
export { RobotsCache, RobotsDisallowedError } from "./politeness/robots.js";
export type { RobotsRules, RobotsCacheOptions, RobotsFetcher } from "./politeness/robots.js";

// Headless Chrome (needs the optional peer `puppeteer-core`).
export { createBrowserSession } from "./browser/session.js";
export type { BrowserSession, BrowserSessionOptions, PageRequest } from "./browser/session.js";
export { Semaphore } from "./browser/semaphore.js";

// Parsing.
export { parseHtml, stripHtml, absoluteUrl } from "./parse/html.js";
export type { CheerioAPI } from "./parse/html.js";
export { parseRssItems } from "./parse/feed.js";
export type { FeedItem } from "./parse/feed.js";
export {
  extractJsonLd,
  jsonLdNodes,
  jsonLdTypes,
  hasJsonLdType,
  jsonLdByType,
  itemListEntries,
} from "./parse/jsonld.js";
export type { JsonLdNode, JsonLdExtraction } from "./parse/jsonld.js";

// The site-adapter seam.
export { ok, partial } from "./adapter/types.js";
export type {
  SiteAdapter,
  ScrapeContext,
  AdapterRunOptions,
  AdapterResult,
} from "./adapter/types.js";
export { extractCards, readField } from "./adapter/selectors.js";
export type { SiteSelectors, FieldSelector } from "./adapter/selectors.js";
export { runAdapters } from "./adapter/runner.js";
export type { RunAdaptersOptions, AdapterOutcome } from "./adapter/runner.js";
