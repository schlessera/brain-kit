/**
 * Shared behaviour for the job-board adapters.
 *
 * Everything generic about scraping — the HTTP client, robots.txt, per-host
 * pacing, retries, HTML stripping, RSS parsing, the headless browser — now
 * lives in `@schlessera/brain-scrape`. What is left here is the part that is
 * actually about jobs: the `RawJob` shape, the per-board metadata, and
 * the `PageLedger` that decides whether a board's zero is a zero or a
 * failure.
 *
 * The shared runner supplies context through `scrape(ctx, options)`. This
 * concrete base gives board parsers that context for one call; boards do not
 * construct clients or expose a second bind lifecycle.
 */
import {
  parseRssItems,
  stripHtml,
  type FetchOptions,
  type ScrapeContext,
  type AdapterRunOptions,
  type AdapterResult,
} from "@schlessera/brain-scrape";
import { hostOf } from "@schlessera/brain-scrape/internal";

import type { RawJob, JobAdapter, Source, SourceStatus } from "../types.js";

/** What one page an adapter attempted turned out to be. */
export type PageReading = "parsed" | "empty" | "unrecognised" | "failed";

/** Options for `PageLedger.read`; each key is a separate claim about the page. */
export interface PageReadOptions {
  /**
   * The page said, in the board's OWN terms, that it holds no postings: an
   * API answering with its envelope and an empty record list, a feed with a
   * channel and no items. Not "the body was short", and not a guess.
   *
   * A board with no way to prove its own empty state leaves this alone, and
   * zero rows from it is reported as a parse failure. That direction is
   * deliberate: a false alarm is one look at a fixture, and the silence this
   * issue is named after cost the epic several months.
   */
  declaredEmpty?: boolean;
  /**
   * This page was fetched only as the continuation of one already read, so
   * nothing on it means the end of the list rather than a parser that cannot
   * read the board. Only pagination may claim this — a board's second
   * CATEGORY is not a continuation of its first, and an empty one there is a
   * real finding.
   *
   * The claim is CHECKED, not trusted: it only counts when some earlier page
   * in this run actually parsed. A loop that keeps going after its first page
   * threw would otherwise excuse page 2 for a challenge page it has no reason
   * to excuse, which is the silence this whole change removes wearing a
   * pagination hat.
   */
  continuation?: boolean;
  /** Where the body came from, when that can differ from `url`. */
  from?: string;
}

/**
 * Two hosts belong to the same site when one is the other, modulo a `www.`
 * prefix or a subdomain. Apex-to-`www` and `m.`-to-apex are the redirects
 * every one of these boards does routinely; a hop to a different registrable
 * name is the one worth reporting.
 *
 * The leading dot in the suffix test is what keeps `notexample.com` from
 * counting as `example.com`. What it does NOT do is consult the public suffix
 * list, so a hop between two sites under a shared one — `a.github.io` to
 * `github.io` — reads as the same site. Closing that means shipping the list,
 * and no board here is hosted under one; the miss is recorded rather than
 * traded for a dependency.
 */
function sameSite(a: string, b: string): boolean {
  const bare = (url: string) => hostOf(url).replace(/^www\./, "");
  const [left, right] = [bare(a), bare(b)];
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/**
 * The pages one `scrape()` read, what each turned out to be, and what that
 * adds up to.
 *
 * It exists so the judgement "is zero rows a zero or a failure?" is made in
 * ONE place for every board, rather than once per board by omission. An
 * adapter reports each page it read and each one it could not reach; the
 * ledger derives the errors a silent page deserves and the `SourceStatus` the
 * run gets, and `BaseAdapter.makeResult` will not build a result without one.
 */
export class PageLedger {
  /** Everything worth telling the operator, in the order it happened. */
  readonly errors: string[] = [];
  private readonly readings: PageReading[] = [];

  /** `board` prefixes the messages, so a joined run report stays attributable. */
  constructor(private readonly board: string) {}

  /**
   * Record what one page turned out to be.
   *
   * `rows` is what the parser read off it. What the page arriving with
   * content and yielding nothing MEANS is decided by `opts` — see
   * `PageReadOptions`.
   */
  read(url: string, rows: number, opts: PageReadOptions = {}): void {
    const from = opts.from ?? url;
    if (!sameSite(url, from)) {
      // A redirect to another site answers 200 and parses like a healthy page.
      // Reported whatever the row count is: rows scraped off somebody else's
      // markup under this board's name are worse than no rows at all.
      this.errors.push(
        `${this.board} ${url}: served by ${hostOf(from)} after a redirect — the board may have moved or been retired`
      );
    }

    if (rows > 0) {
      this.readings.push("parsed");
      return;
    }
    if (opts.declaredEmpty || (opts.continuation && this.readings.includes("parsed"))) {
      this.readings.push("empty");
      return;
    }
    this.readings.push("unrecognised");
    this.errors.push(
      `${this.board} ${url}: parsed 0 jobs from a page that does not say it is empty — ` +
        `selector drift, a challenge page, or markup that is not this board's`
    );
  }

  /**
   * The page never arrived, or never reached a state the parser could read.
   *
   * It is RECORDED, not merely reported. A failed attempt that left no
   * reading behind would let the other pages decide the status on their own,
   * so a board with four empty categories and one that threw would come back
   * as a clean `empty` — a zero with an error next to it, which is the shape
   * this whole change exists to remove.
   *
   * Callers cannot always tell a fetch that failed from a parse that threw
   * over a body that did arrive, because one `try` usually covers both. That
   * is why this takes the pessimistic reading rather than asking.
   */
  unreachable(url: string, cause: unknown): void {
    this.readings.push("failed");
    this.errors.push(`${this.board} ${url} failed: ${cause}`);
  }

  /**
   * Something wrong with the rows themselves — a card that carried no
   * company, a description that had to be dropped. It is an error, but it is
   * not a claim about whether the page was readable, so it does not move the
   * status. #36's truncation and enrichment failures belong here.
   */
  note(message: string): void {
    this.errors.push(message);
  }

  /**
   * What the run adds up to. `rows` is the adapter's whole deduplicated set.
   *
   * `empty` is the strict one: EVERY page attempted has to have come back
   * readable, and at least reading as empty. One page that failed or that was
   * not recognised is enough to deny the board a clean zero, because a board
   * that could not read one of its own listings does not know whether it has
   * postings there.
   */
  status(rows: number): SourceStatus {
    if (rows > 0) return "ok";
    // No attempt at all, or nothing that arrived: the board did not run.
    if (this.readings.every((reading) => reading === "failed")) return "not_run";
    if (this.readings.every((reading) => reading === "empty" || reading === "parsed")) {
      return "empty";
    }
    return "unparseable";
  }
}

export abstract class BaseAdapter implements JobAdapter {
  abstract readonly source: Source;
  abstract readonly name: string;
  abstract readonly tier: 1 | 2 | 3;
  needsBrowser = false;
  needsProxy = false;
  /** See `JobAdapter.detailFetchOptions`. Declared only: a board sets it. */
  declare readonly detailFetchOptions?: FetchOptions;
  /** See `JobAdapter.detailHosts`. Declared only: a board sets it. */
  declare readonly detailHosts?: readonly string[];

  /** Shared identity; job-domain source names remain unchanged. */
  get id(): Source { return this.source; }

  private context?: ScrapeContext;

  /** Available only during the shared scrape call. */
  protected get ctx(): ScrapeContext {
    if (!this.context) throw new Error(`${this.name} adapter is outside a scrape call`);
    return this.context;
  }

  async scrape(ctx: ScrapeContext, options: AdapterRunOptions): Promise<AdapterResult<RawJob>> {
    if (this.context) throw new Error(`${this.name} adapter is already running`);
    this.context = ctx;
    try { return await this.scrapePages(options); }
    finally { this.context = undefined; }
  }

  /** Honor per-run fetch inputs while keeping board pacing as a floor. */
  protected fetchOptions(options: AdapterRunOptions, board: FetchOptions = {}): FetchOptions {
    return {
      ...board, ...options.fetch,
      headers: { ...board.headers, ...options.fetch?.headers },
      ...(board.delayMs === undefined ? {} : { delayMs: Math.max(board.delayMs, options.fetch?.delayMs ?? 0) }),
      proxy: options.proxy ?? options.fetch?.proxy ?? board.proxy,
    };
  }

  /** The polite HTTP client for this run. */
  protected get http() { return this.ctx.http; }

  protected abstract scrapePages(options: AdapterRunOptions): Promise<AdapterResult<RawJob>>;

  protected stripHtml(html: string): string {
    return stripHtml(html);
  }

  protected parseRssItems(xml: string): Array<Record<string, string>> {
    return parseRssItems(xml);
  }

  /** A fresh ledger for one `scrape()` call. */
  protected ledger(): PageLedger {
    return new PageLedger(this.name);
  }

  /**
   * The envelope, with the run's status derived from the ledger.
   *
   * The ledger is required rather than optional: an adapter that reported no
   * page readings gets `not_run`, which is the honest answer for one that
   * never fetched anything and a loud one for a board that forgot to report.
   */
  protected makeResult(jobs: RawJob[], pages: PageLedger, cursor?: string): AdapterResult<RawJob> {
    return {
      items: jobs,
      errors: pages.errors,
      cursor,
      status: pages.status(jobs.length),
    };
  }
}
