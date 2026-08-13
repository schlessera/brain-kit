/**
 * Listing-parser regression tests.
 *
 * The markup snippets below are trimmed from real responses captured while
 * fixing these adapters. They exist because every failure they cover was
 * silent: builtin and nodesk reported "0 jobs found, 0 errors" for weeks, and
 * dice happily stored positional junk in the company column. A parser that
 * matches nothing must fail a test, not a scrape run nobody reads.
 */

import { describe, expect, test } from "bun:test";
import { BuiltInAdapter } from "../src/adapters/builtin";
import { NodeskAdapter } from "../src/adapters/nodesk";
import { JobgetherAdapter } from "../src/adapters/jobgether";
import { DiceAdapter } from "../src/adapters/dice";
import { RemotelyDeAdapter } from "../src/adapters/remotelyde";
import { RemoteInEuropeAdapter } from "../src/adapters/remoteineurope";

// Adapters keep their parsers private; these tests exercise them directly
// rather than going over the network.
const parse = (adapter: object, method: string, html: string, ...rest: unknown[]): any =>
  (adapter as any)[method](html, ...rest);

describe("BuiltIn listing parser", () => {
  // Built In dropped JSON-LD entirely and moved job URLs from
  // /jobs/remote/{slug} to /job/{slug}/{id}.
  const html = `
    <div class="left-side-tile-item-2">
      <a href="/company/navan" data-id="company-title" data-builtin-track-job-id="10662860"><span>Navan</span></a>
    </div>
    <div class="left-side-tile-item-3"><h2>
      <a href="/job/navan-pro-travel-consultant/10662860" data-id="job-card-title" data-alias="/job/navan-pro-travel-consultant/10662860">Navan Pro Travel Consultant</a>
    </h2></div>
    <div class="left-side-tile-item-2">
      <a href="/company/acme" data-id="company-title" data-builtin-track-job-id="10663257"><span>Acme &amp; Co</span></a>
    </div>
    <div class="left-side-tile-item-3"><h2>
      <a href="/job/staff-engineer/10663257" data-id="job-card-title">Staff Engineer</a>
    </h2></div>`;

  const listings = parse(new BuiltInAdapter(), "parseListings", html);

  test("finds every card", () => {
    expect(listings).toHaveLength(2);
  });

  test("pairs each job with its own company", () => {
    expect(listings[0]).toMatchObject({ id: "10662860", title: "Navan Pro Travel Consultant", company: "Navan" });
    expect(listings[1]).toMatchObject({ id: "10663257", title: "Staff Engineer", company: "Acme & Co" });
  });

  test("ignores non-job links", () => {
    const noise = `<a href="/company/navan">Navan</a><a href="/jobs/remote">All remote jobs</a>`;
    expect(parse(new BuiltInAdapter(), "parseListings", noise)).toHaveLength(0);
  });
});

describe("Nodesk listing parser", () => {
  // NoDesk minifies to *unquoted* attributes; the old quoted-only patterns
  // matched nothing, which is the whole reason this board reported zero.
  const html = `
    <li class="dt-s"><div>
      <h2 class="f8 fw6"><a class="link dim indigo-700" href=/remote-jobs/clipboard-onboarding-documents-associate/>Onboarding Documents Associate</a></h2>
      <h3 class="f8 fw4"><a class="link dim grey-900" href=/remote-companies/clipboard/>Clipboard</a></h3>
      <div><h4 class="f9">Remote:</h4><h5 class="f9"><a class="link" href=/remote-jobs/asia/>Asia</a></h5></div>
    </div></li>
    <li class="dt-s"><div>
      <h2 class="f8 fw6"><a class="link dim indigo-700" href="/remote-jobs/acme-senior-engineer/">Senior Engineer</a></h2>
      <h3 class="f8 fw4"><a class="link dim grey-900" href="/remote-companies/acme/">Acme</a></h3>
    </div></li>`;

  const listings = parse(new NodeskAdapter(), "parseListings", html);

  test("parses unquoted and quoted attributes alike", () => {
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      slug: "clipboard-onboarding-documents-associate",
      title: "Onboarding Documents Associate",
      company: "Clipboard",
      location: "Asia",
    });
    expect(listings[1]).toMatchObject({ slug: "acme-senior-engineer", company: "Acme" });
  });

  test("skips category and region links sharing the /remote-jobs/ prefix", () => {
    const nav = `
      <h2><a href=/remote-jobs/customer-support/>Customer Support Jobs</a></h2>
      <h2><a href=/remote-jobs/entry-level/>Entry-Level Jobs</a></h2>
      <h2><a href=/remote-jobs/europe/>Europe</a></h2>`;
    expect(parse(new NodeskAdapter(), "parseListings", nav)).toHaveLength(0);
  });

  test("source_id keeps the absolute-URL shape already in the database", () => {
    const job = (new NodeskAdapter() as any).toRawJob(listings[0]);
    expect(job.source_id).toBe(
      "https://nodesk.co/remote-jobs/clipboard-onboarding-documents-associate/"
    );
  });
});

describe("Jobgether listing parser", () => {
  const html = `
    <div class="card">
      <a href="/offer/6a7d0212490731f1e19a3fc6-designer-spec" class="font-semibold" title="Designer Spec">Designer Spec</a>
      <p><a href="/remote-jobs/company-trafileatechecommercegroup">Trafilea Tech E-commerce Group</a></p>
    </div>
    <div class="card">
      <a href="/offer/6a7d2c58490731f1e19ab02c-senior-engineer" title="Senior Engineer">Senior Engineer</a>
      <p><a href="/remote-jobs/company-acme">Acme &amp; Co</a></p>
      <span>$120,000 - $150,000</span>
    </div>`;

  const jobs = parse(new JobgetherAdapter(), "parseListings", html);

  test("reads the employer's display name, not the URL slug", () => {
    // The old adapter title-cased "company-trafileatechecommercegroup".
    expect(jobs[0].company).toBe("Trafilea Tech E-commerce Group");
    expect(jobs[1].company).toBe("Acme & Co");
  });

  test("keeps the historical {id}-{slug} source_id", () => {
    expect(jobs[0].source_id).toBe("6a7d0212490731f1e19a3fc6-designer-spec");
    expect(jobs[0].url).toBe(
      "https://jobgether.com/offer/6a7d0212490731f1e19a3fc6-designer-spec"
    );
  });

  test("picks up a salary range and its currency", () => {
    expect(jobs[1].salary_raw).toBe("$120,000 - $150,000");
    expect(jobs[1].salary_currency).toBe("USD");
  });
});

describe("Dice listing parser", () => {
  const html = `
    <a aria-label="View Details for Senior AI Security Architect (b2433298972fd63e)" href="/job-detail/c6e92bde-222c-4260-b14e-c2c845da7e4e">View</a>
    <a aria-label="View Details for AI Architect &amp; Lead (0168f45f8486ff76)" href="/job-detail/df192871-2c35-4276-abc1-080c0549f653">View</a>`;

  const listings = parse(new DiceAdapter(), "extractListings", html);

  test("extracts the job UUID and title from the aria-label", () => {
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      id: "c6e92bde-222c-4260-b14e-c2c845da7e4e",
      title: "Senior AI Security Architect",
      url: "https://www.dice.com/job-detail/c6e92bde-222c-4260-b14e-c2c845da7e4e",
    });
  });

  test("decodes entities in the title", () => {
    expect(listings[1].title).toBe("AI Architect & Lead");
  });

  test("falls back to bare job-detail links when the aria-label changes", () => {
    const drifted = `<a href="/job-detail/c6e92bde-222c-4260-b14e-c2c845da7e4e">Some job</a>`;
    const fallback = parse(new DiceAdapter(), "extractListings", drifted);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].id).toBe("c6e92bde-222c-4260-b14e-c2c845da7e4e");
  });

  test("deduplicates repeated links to the same job", () => {
    const dupes = html + html;
    expect(parse(new DiceAdapter(), "extractListings", dupes)).toHaveLength(2);
  });
});

describe("remotely.de listing parser", () => {
  // Every row this adapter ever stored was navigation: source_id "seite/2"
  // titled "Weiter", "bereich/engineering" titled "Engineering". Job URLs are
  // /job/{slug}; the old fallback scanned /remote-jobs/{slug} and so could only
  // ever match the site chrome.
  const navigation = `
    <a href="/remote-jobs/seite/2">Weiter</a>
    <a href="/remote-jobs/seite/3">Weiter</a>
    <a href="/home-office-jobs/bereich/engineering">Engineering</a>
    <a href="/firma/ethos">Ethos</a>
    <a href="/gehaltsrechner">Gehaltsrechner</a>`;

  test("stores no navigation links as jobs", () => {
    const found = parse(new RemotelyDeAdapter(), "parseListings", navigation) as unknown as Map<string, string>;
    expect(found.size).toBe(0);
  });

  test("prefers the ItemList title over anchor text", () => {
    // Anchor text runs past the heading into the card teaser, which produced
    // sentence-length "titles"; the CollectionPage ItemList has the real one.
    const html = `
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","mainEntity":{"@type":"ItemList","itemListElement":[
        {"@id":"https://www.remotely.de/job/acme-senior-engineer-mwd","name":"Senior Engineer (m/w/d)"}
      ]}}</script>
      <a href="/job/acme-senior-engineer-mwd">Senior Engineer (m/w/d) Acme Remote Job bei Acme! Werde Held. Jetzt bewerben (Deutsch &amp; Englisch).</a>`;
    const found = parse(new RemotelyDeAdapter(), "parseListings", html) as unknown as Map<string, string>;
    expect(found.get("acme-senior-engineer-mwd")).toBe("Senior Engineer (m/w/d)");
  });

  test("blanks an implausibly long anchor title rather than storing a sentence", () => {
    const long = "x".repeat(200);
    const html = `<a href="/job/acme-role">${long}</a>`;
    const found = parse(new RemotelyDeAdapter(), "parseListings", html) as unknown as Map<string, string>;
    expect(found.get("acme-role")).toBe("");
  });

  test("recovers title and employer from the document title on pages with no JobPosting", () => {
    // Expired and sponsored placeholder pages ship only a BreadcrumbList.
    const stub = {
      source: "remotelyde",
      source_id: "https://www.remotely.de/job/x",
      title: "",
      company: "Unknown",
    };
    const page = `<title>ERP Finance Consultant (m/f/d) bei NVision Quantum Technologies GmbH | remotely.de</title>`;
    const out = (new RemotelyDeAdapter() as any).fromTitleTag(stub, page);
    expect(out.title).toBe("ERP Finance Consultant (m/f/d)");
    expect(out.company).toBe("NVision Quantum Technologies GmbH");
  });
});

describe("Remote in Europe listing parser", () => {
  // Stripping the whole anchor produced titles like
  // "Canonical 1 Apr Canonical Senior Design Researcher", and picked up the
  // sponsored promo card as a company called "Learn More".
  const html = `
    <div class="card sponsor"><a href="#" class="top-link w-inline-block">
      <h3 class="title h6-size card-job sp">CodeFast - Learn to code in weeks</h3>
      <div class="button-secondary small sponsor"><div>Learn More</div></div>
    </a></div>
    <div role="listitem" class="job-item w-dyn-item">
      <a href="/job/email-developer-fundraising" class="card job w-inline-block">
        <div class="date-text-mobile">22 May</div>
        <div fs-cmsfilter-field="company" class="card-link homepage">Wikimedia Foundation</div>
        <div class="job-title-container">
          <h3 fs-cmsfilter-field="job-title" class="title h6-size card-job">Email Developer (Fundraising) (1 year Contract)</h3>
        </div>
      </a>
    </div>`;

  const listings = parse(new RemoteInEuropeAdapter(), "parseListings", html, "all");

  test("reads title and company from the CMS filter fields", () => {
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      slug: "email-developer-fundraising",
      title: "Email Developer (Fundraising) (1 year Contract)",
      company: "Wikimedia Foundation",
    });
  });

  test("skips the sponsored promo card", () => {
    expect(listings.some((l: any) => l.company === "Learn More")).toBe(false);
  });

  test("extracts the description and location from a detail page", () => {
    const detail = `
      <div class="label-location">France, Germany, Netherlands</div>
      <div class="card-job-post-content-bottom"><div class="rich-text-block-2 w-richtext">
        <p><strong>Summary</strong></p><p>${"The Wikimedia Foundation is hiring an Email Developer. ".repeat(4)}</p>
      </div></div>`;
    const out = (new RemoteInEuropeAdapter() as any).parseDetail(detail);
    expect(out.location).toBe("France, Germany, Netherlands");
    expect(out.description).toContain("Wikimedia Foundation");
  });

  test("a year-less listing date resolves to the most recent past occurrence", () => {
    const iso = (new RemoteInEuropeAdapter() as any).parseListingDate("22 May");
    expect(iso).toBeDefined();
    expect(new Date(iso).getTime()).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
  });
});
