/**
 * The shared JobPosting mapper, against what boards actually serve.
 *
 * Every input here is a capture: whole `<script>` elements lifted out of a
 * real response on 2026-09-22 and committed under `fixtures/jsonld/`, with
 * `fixtures/jsonld/README.md` recording where each came from and what it is
 * here to prove. Two inputs are marked ASSEMBLED — a shape schema.org
 * documents that no board was observed serving, built by re-shaping nodes
 * captured here rather than by writing JSON by hand.
 *
 * Nothing in this file touches the network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ScrapeClient, extractJsonLd, type FetchOptions } from "@schlessera/brain-scrape";

import { BaseAdapter } from "../src/adapters/base";
import {
  jobsFromJsonLd,
  mapBaseSalary,
  mapEmploymentType,
  normalizeJsonLdDate,
  type JobPostingMapOptions,
} from "../src/jsonld";
import type { JsonLdNode } from "@schlessera/brain-scrape";
import type { RawJob, Source } from "../src/types";

const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf-8");
}

/**
 * The pattern the one adapter that had JSON-LD used, before this issue
 * replaced it — `remotelyde.ts:53`. Held against each fixture so "tolerant" is
 * a measurement rather than a claim.
 */
const BARE_TAG_ONLY = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function mapped(file: string, source: Source, opts: Partial<JobPostingMapOptions> = {}) {
  return jobsFromJsonLd(fixture("jsonld", file), { source, ...opts });
}

function onlyJob(file: string, source: Source, opts: Partial<JobPostingMapOptions> = {}): RawJob {
  const result = mapped(file, source, opts);
  expect(result.errors).toEqual([]);
  expect(result.jobs).toHaveLength(1);
  return result.jobs[0];
}

describe("the script tag itself", () => {
  const withAttributes: Array<[string, string]> = [
    ["remotelyde-detail.html", '<script id="job-posting-jsonld" type="application/ld+json">'],
    ["nodesk-detail.html", "<script type=application/ld+json>"],
    ["simplyhired-detail.html", '<script type="application/ld+json" data-next-head="">'],
    ["dice-detail.html", '<script type="application/ld+json" data-testid="jobDetailStructuredData" id="jobDetailStructuredData">'],
  ];

  for (const [file, opener] of withAttributes) {
    test(`${file} is extracted although its tag is not bare`, () => {
      const html = fixture("jsonld", file);
      expect(html).toContain(opener);
      // What the bare-tag-only pattern makes of the same bytes: nothing.
      expect(html.match(BARE_TAG_ONLY)).toBeNull();
      expect(extractJsonLd(html).documents.length).toBeGreaterThan(0);
    });
  }

  test("the listing tag that started this issue is extracted too", () => {
    const html = fixture("boards", "remotelyde", "listing.html");
    expect(html).toContain('<script id="collection-page-jsonld" type="application/ld+json">');
    expect(html.match(BARE_TAG_ONLY)).toBeNull();
    expect(extractJsonLd(html).documents).toHaveLength(1);
  });
});

describe("a bare JobPosting node", () => {
  test("remotely.de: title, company, url, location and an ISO date", () => {
    const job = onlyJob("remotelyde-detail.html", "remotelyde");

    expect(job.title).toBe("Senior Backend Engineer - Databases - Analytics | Germany | Remote");
    expect(job.company).toBe("Grafana Labs");
    expect(job.source_id).toBe("718323");
    expect(job.url).toBe(
      "https://www.remotely.de/job/grafana-labs-senior-backend-engineer-databases-analytics-germany-remote"
    );
    // No `jobLocation` at all: where applicants may be is the only geography
    // this posting states.
    expect(job.location).toBe("Spain, SE, United Kingdom, IE, Germany");
    expect(job.remote_type).toBe("fully_remote");
    expect(job.published_at).toBe("2026-09-22T08:17:08.000Z");
    // The description is HTML on the wire and text by the time it is stored.
    expect(job.description).toContain("Grafana Labs is the company behind");
    expect(job.description).not.toContain("<p>");
    // Nothing said what kind of employment it is, so nothing is claimed.
    expect(job.job_type).toBeUndefined();
  });

  test("the BreadcrumbList beside it is not read as jobs", () => {
    const result = mapped("remotelyde-detail.html", "remotelyde");
    // Same ListItem -> {@id, name} shape as a job listing, three entries deep.
    expect(fixture("jsonld", "remotelyde-detail.html")).toContain('"@type":"BreadcrumbList"');
    expect(result.jobs).toHaveLength(1);
    expect(result.references).toEqual([]);
  });

  test("dice: the locality out of a PostalAddress, and an expiry", () => {
    const job = onlyJob("dice-detail.html", "dice");

    expect(job.company).toBe("FishEye Software");
    // `identifier.name` is the COMPANY on this board; the id is the value.
    expect(job.source_id).toBe("c267e627-504f-412f-b8e8-cc8a387b525d");
    expect(job.location).toBe("Maynard");
    expect(job.job_type).toBe("full_time");
    expect(job.expires_at).toBe("2026-10-23T05:05:43.000Z");
  });

  test("dice: an on-site post is not called remote by its applicant geography", () => {
    const html = fixture("jsonld", "dice-detail.html");
    // It says so in its own description, and it has no `jobLocationType`.
    expect(html).toContain("100% on-site in Maynard, MA");
    expect(html).not.toContain("TELECOMMUTE");
    // What it does have is where applicants must live, which says nothing
    // about where the work happens.
    expect(html).toContain('"applicantLocationRequirements"');

    expect(onlyJob("dice-detail.html", "dice").remote_type).toBe("unknown");
  });

  test("nodesk: employmentType arrives as an array", () => {
    const html = fixture("jsonld", "nodesk-detail.html");
    expect(html).toContain('"employmentType":["FULL_TIME"]');
    expect(onlyJob("nodesk-detail.html", "nodesk").job_type).toBe("full_time");
  });
});

describe("a page that serves several documents", () => {
  test("jobgether: one JobPosting among a BreadcrumbList and an @graph", () => {
    const html = fixture("jsonld", "jobgether-offer.html");
    expect(extractJsonLd(html).documents).toHaveLength(3);

    const job = onlyJob("jobgether-offer.html", "jobgether");
    expect(job.company).toBe("NVIDIA");
    // The @graph holds Organization, WebSite and WebPage nodes. None is a job,
    // and none of them becomes one.
    expect(html).toContain('"@type":"WebSite"');
  });
});

describe("an @graph whose ItemList has no @type", () => {
  test("builtin: every entry is a reference carrying the description", () => {
    const result = jobsFromJsonLd(fixture("boards", "builtin", "listing-jsonld.html"), {
      source: "builtin",
    });

    // No node on the page says JobPosting, which is why a mapper that requires
    // it reads this page as empty.
    expect(result.jobs).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.references).toHaveLength(3);
    expect(result.references[0].title).toBe("Staff Software Engineer, Assets");
    expect(result.references[0].url).toBe("https://builtin.com/job/staff-software-engineer-assets/11309150");
    for (const reference of result.references) {
      expect(reference.description!.length).toBeGreaterThan(50);
    }
  });
});

describe("a CollectionPage whose ItemList entries are bare references", () => {
  test("remotely.de: a title and a job URL, and nothing to invent a row from", () => {
    const result = jobsFromJsonLd(fixture("boards", "remotelyde", "listing.html"), {
      source: "remotelyde",
    });

    expect(result.jobs).toEqual([]);
    expect(result.references).toHaveLength(12);
    for (const reference of result.references) {
      expect(reference.title.length).toBeGreaterThan(0);
      // The real job URL — `/job/<slug>`, not the `/remote-jobs/<slug>`
      // category chrome the link fallback settles for.
      expect(reference.url).toStartWith("https://www.remotely.de/job/");
      // No company and no description anywhere in this list. Those only exist
      // on the detail page.
      expect(reference.description).toBeUndefined();
    }
  });
});

describe("a top-level array of nodes", () => {
  /**
   * ASSEMBLED. No board out of the 17 pages probed on 2026-09-22 served its
   * nodes as one JSON array — they used several script tags or an `@graph`.
   * Schema.org allows the array, so this is the two documents remotely.de
   * serves as siblings, re-shaped into the form it allows. The nodes are the
   * capture's; only the wrapper is this test's.
   */
  const arrayOfTheSameNodes = `<script type="application/ld+json">${JSON.stringify(
    extractJsonLd(fixture("jsonld", "remotelyde-detail.html")).documents
  )}</script>`;

  test("maps the same job the two sibling tags do", () => {
    const fromArray = jobsFromJsonLd(arrayOfTheSameNodes, { source: "remotelyde" });
    const fromSiblings = mapped("remotelyde-detail.html", "remotelyde");

    expect(fromArray.errors).toEqual([]);
    expect(fromArray.jobs).toEqual(fromSiblings.jobs);
  });
});

describe("baseSalary", () => {
  test("the two documented shapes give the same figure", () => {
    const short = onlyJob("dice-detail.html", "dice");
    // ASSEMBLED: Dice's own MonetaryAmount, rewritten into the long form —
    // the number moved into a QuantitativeValue with the unit it implies.
    const long = extractJsonLd(fixture("jsonld", "dice-detail.html")).documents[0] as JsonLdNode;
    const amount = long.baseSalary as JsonLdNode;
    const rewritten = {
      ...long,
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: amount.currency,
        value: { "@type": "QuantitativeValue", value: amount.value, unitText: "YEAR" },
      },
    };

    const mappedLong = mapBaseSalary(rewritten);
    expect(mappedLong.min).toBe(short.salary_min!);
    expect(mappedLong.max).toBe(short.salary_max!);
    expect(mappedLong.currency).toBe(short.salary_currency!);
    // A single figure is its own floor and its own ceiling.
    expect(short.salary_min).toBe(80000);
    expect(short.salary_max).toBe(80000);
  });

  test("an hourly rate is annualized, and says so", () => {
    const job = onlyJob("simplyhired-detail.html", "simplyhired");

    // 20-22 USD/hour x 2080 hours, the same factor salary.ts uses for a rate
    // read out of a salary string.
    expect(job.salary_min).toBe(41600);
    expect(job.salary_max).toBe(45760);
    expect(job.salary_currency).toBe("USD");
    expect(job.salary_raw).toBe("20-22 USD/HOUR [annualized from hourly]");
  });

  test("a monthly rate is annualized by twelve", () => {
    // ASSEMBLED: NoDesk's own QuantitativeValue with the unit changed. No
    // board observed on 2026-09-22 quoted a monthly rate; the figures are the
    // capture's and only `unitText` is this test's.
    const posting = extractJsonLd(fixture("jsonld", "nodesk-detail.html")).documents[0] as JsonLdNode;
    const salary = posting.baseSalary as JsonLdNode;
    const monthly = {
      baseSalary: {
        ...salary,
        value: { ...(salary.value as JsonLdNode), unitText: "MONTH" },
      },
    };

    expect(mapBaseSalary(monthly)).toEqual({
      min: 480000,
      max: 660000,
      currency: "USD",
      raw: "40000-55000 USD/MONTH",
    });
  });

  test("a posting with no salary claims none", () => {
    expect(mapBaseSalary({ "@type": "JobPosting" })).toEqual({});
    // Recruitee serves the key explicitly empty.
    expect(mapBaseSalary({ baseSalary: null })).toEqual({});
  });

  test("an empty or zero figure is not a salary of zero", () => {
    // `Number("")` is 0, so an empty value would otherwise be published as pay.
    expect(mapBaseSalary({ baseSalary: "" }).min).toBeUndefined();
    expect(mapBaseSalary({ baseSalary: "" }).raw).toBeUndefined();
    expect(
      mapBaseSalary({ baseSalary: { "@type": "MonetaryAmount", currency: "EUR", value: "" } }).raw
    ).toBeUndefined();
    expect(
      mapBaseSalary({
        baseSalary: { value: { "@type": "QuantitativeValue", minValue: 0, maxValue: 0 } },
      }).min
    ).toBeUndefined();
  });

  test("a currency written on the nested value is not lost", () => {
    // Where it belongs is the MonetaryAmount; boards have put it inside, and
    // the mapper this replaces read it from there.
    const nested = mapBaseSalary(
      { baseSalary: { value: { minValue: 100000, maxValue: 120000, currency: "USD" } } },
      "EUR"
    );
    expect(nested.currency).toBe("USD");
    // With neither, the board's own default still applies.
    expect(mapBaseSalary({ baseSalary: { value: { minValue: 60000 } } }, "EUR").currency).toBe("EUR");
  });
});

describe("the source id", () => {
  test("comes from the identifier's value, never from its label", () => {
    // Dice's label is the COMPANY. Two postings by one employer would collapse
    // into one stored row if the label were read as the id.
    const first = { "@type": "JobPosting", title: "A", identifier: { "@type": "PropertyValue", name: "FishEye Software", value: "uuid-1" }, url: "https://example.test/1" };
    const second = { ...first, title: "B", identifier: { "@type": "PropertyValue", name: "FishEye Software", value: "uuid-2" }, url: "https://example.test/2" };
    const listed = { "@type": "JobPosting", title: "C", identifier: [{ "@type": "PropertyValue", name: "FishEye Software", value: "uuid-3" }], url: "https://example.test/3" };

    const html = `<script type="application/ld+json">${JSON.stringify([first, second, listed])}</script>`;
    const result = jobsFromJsonLd(html, { source: "dice" });

    expect(result.jobs.map((job) => job.source_id)).toEqual(["uuid-1", "uuid-2", "uuid-3"]);
  });

  test("keeps the separator the mapper this replaces used, for rows already stored", () => {
    const job = jobsFromJsonLd(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting",
        title: "Customer Support Representative",
        hiringOrganization: { name: "CO2Lift" },
      })}</script>`,
      { source: "remotelyde" }
    ).jobs[0];

    expect(job.source_id).toBe("CO2Lift-Customer Support Representative");
  });

  test("falls back to the URL when the identifier carries only a label", () => {
    const job = jobsFromJsonLd(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting",
        title: "A",
        identifier: { "@type": "PropertyValue", name: "FishEye Software" },
        url: "https://example.test/1",
      })}</script>`,
      { source: "dice" }
    ).jobs[0];

    expect(job.source_id).toBe("https://example.test/1");
  });
});

describe("employmentType", () => {
  test("maps the spellings boards use into the three buckets", () => {
    expect(mapEmploymentType("FULL_TIME")).toBe("full_time");
    expect(mapEmploymentType(["FULL_TIME"])).toBe("full_time");
    expect(mapEmploymentType("PART_TIME")).toBe("part_time");
    expect(mapEmploymentType("Teilzeit")).toBe("part_time");
    expect(mapEmploymentType("CONTRACTOR")).toBe("contract");
    expect(mapEmploymentType("TEMPORARY")).toBe("contract");
    // Outside the three, nothing is claimed rather than something rounded.
    expect(mapEmploymentType("INTERN")).toBeUndefined();
    expect(mapEmploymentType(undefined)).toBeUndefined();
  });

  test("a permanent German post is not read as a fixed-term one", () => {
    // "unbefristet" is PERMANENT and contains "befristet", which is not.
    expect(mapEmploymentType("Vollzeit, unbefristet")).toBe("full_time");
    expect(mapEmploymentType("Teilzeit (unbefristet)")).toBe("part_time");
    expect(mapEmploymentType("unbefristet")).toBe("full_time");
    // The fixed-term word itself still lands where it belongs.
    expect(mapEmploymentType("befristete Anstellung")).toBe("contract");
    expect(mapEmploymentType("Vollzeit, befristet")).toBe("contract");
  });
});

describe("the publication date", () => {
  test("a Date.toString() is converted, not stored as if it were ISO", () => {
    const html = fixture("jsonld", "jobgether-offer.html");
    // What the board serves, verbatim.
    expect(html).toContain(
      '"datePosted":"Tue Sep 22 2026 06:31:26 GMT+0000 (Coordinated Universal Time)"'
    );

    const job = onlyJob("jobgether-offer.html", "jobgether");
    expect(job.published_at).toBe("2026-09-22T06:31:26.000Z");
    // The same posting's validThrough was ISO already and is unchanged.
    expect(job.expires_at).toBe("2026-11-22T06:31:26.510Z");
  });

  test("a date with no time is left alone rather than given a midnight", () => {
    expect(normalizeJsonLdDate("2026-09-18")).toBe("2026-09-18");
  });

  test("a date-only value still has to be a real day in a plausible year", () => {
    // `new Date("2026-02-30T00:00:00Z")` is not an error — it is the 2nd of
    // March, so a lenient parse would store a day the board never published.
    expect(normalizeJsonLdDate("2026-02-30")).toBeUndefined();
    expect(normalizeJsonLdDate("2026-99-99")).toBeUndefined();
    expect(normalizeJsonLdDate("9999-12-31")).toBeUndefined();
    expect(normalizeJsonLdDate("1970-01-01")).toBeUndefined();
    // A leap day that exists is kept.
    expect(normalizeJsonLdDate("2028-02-29")).toBe("2028-02-29");
  });

  test("anything that is not a date is rejected", () => {
    expect(normalizeJsonLdDate("Vor 3 Tagen")).toBeUndefined();
    expect(normalizeJsonLdDate("")).toBeUndefined();
    expect(normalizeJsonLdDate(null)).toBeUndefined();
    expect(normalizeJsonLdDate({ "@type": "Date" })).toBeUndefined();
    // Parseable, but not a publication date any board could mean.
    expect(normalizeJsonLdDate("Tue Sep 22 1492 06:31:26 GMT+0000")).toBeUndefined();
  });
});

describe("malformed JSON", () => {
  /** A real capture cut short — the failure a truncated response produces. */
  const truncated = fixture("jsonld", "dice-detail.html").slice(0, 2000) + "</script>";

  test("yields no rows and one reported error", () => {
    const result = jobsFromJsonLd(truncated, { source: "dice" });

    expect(result.jobs).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("JSON-LD script 1");
  });

  test("does not abort the board: the adapter reports it and keeps going", async () => {
    /**
     * The smallest adapter that reads structured data: one page, through the
     * shared helper, reporting what it could not parse. Any board wired onto
     * `jobsFromJsonLd` looks like this, and none has to exist yet for the "not
     * a thrown exception" half of the requirement to be checkable.
     */
    class JsonLdBoard extends BaseAdapter {
      readonly source = "builtin" as const;
      readonly name = "Structured-data board";
      readonly tier = 2 as const;

      async scrape() {
        const html = await this.http.getText("https://example.test/jobs");
        const { jobs, errors } = jobsFromJsonLd(html, { source: this.source });
        return this.makeResult(jobs, errors);
      }
    }

    /** Serves one body, and seals every other way out to the network. */
    class StubClient extends ScrapeClient {
      constructor(private readonly body: string) {
        super();
      }
      override async getText(_url: string, _opts: FetchOptions = {}): Promise<string> {
        return this.body;
      }
      override async get(url: string, _opts: FetchOptions = {}): Promise<Response> {
        // Same seal, same wording as board-fixtures.test.ts, so the two do not
        // drift into disagreeing about what a stub is allowed to do.
        throw new Error(
          `StubClient.get(${url}) \u2014 these tests answer from a fixture and must never ` +
            `reach the network. Add the read path you need to StubClient instead.`
        );
      }
    }

    const serving = (body: string) =>
      new JsonLdBoard().bind({ http: new StubClient(body), log: () => {} }).scrape();

    const broken = await serving(truncated);
    expect(broken.jobs).toEqual([]);
    // Reported, named, and returned -- not thrown.
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]).toContain("JSON-LD script 1");

    // The same adapter over the same capture intact, so the failure path is
    // not the only one this exercises.
    const whole = await serving(fixture("jsonld", "dice-detail.html"));
    expect(whole.errors).toEqual([]);
    expect(whole.jobs).toHaveLength(1);
  });
});
