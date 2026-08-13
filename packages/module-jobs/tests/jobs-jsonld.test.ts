import { describe, expect, test } from "bun:test";
import { decodeEntities, extractJsonLd, findJsonLdType } from "../src/html";
import {
  applyJobPosting,
  employmentToJobType,
  parseJsonLdSalary,
  toIsoDate,
} from "../src/jsonld-job";
import { ANNUALIZED_MARKER } from "../src/salary";
import type { RawJob } from "../src/types";

const base: RawJob = {
  source: "dice",
  source_id: "abc",
  title: "Listing Title",
  company: "Unknown",
  location: "Remote",
  remote_type: "fully_remote",
  job_type: "full_time",
};

describe("extractJsonLd", () => {
  test("finds blocks whose script tag carries attributes", () => {
    // The previous regex required `<script type="application/ld+json">` with
    // nothing after the type attribute, so Dice's tag never matched and every
    // job came back without a description.
    const html = `
      <script type="application/ld+json" data-testid="jobDetailStructuredData" id="x">
        {"@type":"JobPosting","title":"AI Architect"}
      </script>`;
    const nodes = extractJsonLd(html);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].title).toBe("AI Architect");
  });

  test("finds the bare no-attribute form too", () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"X"}</script>`;
    expect(extractJsonLd(html)).toHaveLength(1);
  });

  test("flattens arrays and @graph containers", () => {
    const html = `
      <script type="application/ld+json">[{"@type":"BreadcrumbList"},{"@type":"JobPosting","title":"A"}]</script>
      <script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"B"}]}</script>`;
    const titles = extractJsonLd(html)
      .filter((n) => n["@type"] === "JobPosting")
      .map((n) => n.title);
    expect(titles).toEqual(["A", "B"]);
  });

  test("a malformed block does not discard the valid ones", () => {
    const html = `
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json">{"@type":"JobPosting","title":"Survivor"}</script>`;
    expect(findJsonLdType(html, "JobPosting")?.title).toBe("Survivor");
  });

  test("findJsonLdType handles the array form of @type", () => {
    const html = `<script type="application/ld+json">{"@type":["JobPosting","Thing"],"title":"T"}</script>`;
    expect(findJsonLdType(html, "JobPosting")?.title).toBe("T");
  });

  test("returns nothing when there is no JSON-LD at all", () => {
    expect(extractJsonLd("<html><body>no structured data</body></html>")).toEqual([]);
  });
});

describe("decodeEntities", () => {
  test("decodes the entities that survive in attribute values", () => {
    expect(decodeEntities("Ben &amp; Jerry&#39;s")).toBe("Ben & Jerry's");
    expect(decodeEntities("R&amp;D &quot;Lead&quot;")).toBe('R&D "Lead"');
  });
});

describe("employmentToJobType", () => {
  test("maps the schema.org vocabulary", () => {
    expect(employmentToJobType("CONTRACTOR")).toBe("contract");
    expect(employmentToJobType("PART_TIME")).toBe("part_time");
    expect(employmentToJobType("FULL_TIME")).toBe("full_time");
    expect(employmentToJobType("INTERN")).toBe("contract");
  });

  test("handles the array form and unknown values", () => {
    expect(employmentToJobType(["FULL_TIME", "CONTRACTOR"])).toBe("contract");
    expect(employmentToJobType(undefined)).toBeUndefined();
    expect(employmentToJobType("SOMETHING_ELSE")).toBeUndefined();
  });
});

describe("parseJsonLdSalary", () => {
  test("reads a MonetaryAmount range", () => {
    const s = parseJsonLdSalary({
      baseSalary: { currency: "USD", value: { minValue: 120000, maxValue: 150000, unitText: "YEAR" } },
    });
    expect(s.min).toBe(120_000);
    expect(s.max).toBe(150_000);
    expect(s.currency).toBe("USD");
  });

  test("annualizes an hourly QuantitativeValue", () => {
    const s = parseJsonLdSalary({
      baseSalary: { currency: "USD", value: { minValue: 60, maxValue: 80, unitText: "HOUR" } },
    });
    expect(s.min).toBe(60 * 2080);
    expect(s.max).toBe(80 * 2080);
    expect(s.raw).toContain(ANNUALIZED_MARKER);
  });

  test("annualizes a monthly QuantitativeValue", () => {
    const s = parseJsonLdSalary({
      baseSalary: { currency: "EUR", value: { minValue: 7500, maxValue: 9000, unitText: "MONTH" } },
    });
    expect(s.min).toBe(90_000);
    expect(s.max).toBe(108_000);
  });

  test("keeps free-text salary without inventing a number", () => {
    const s = parseJsonLdSalary({
      baseSalary: { currency: "USD", value: "Depends on Experience" },
    });
    expect(s.raw).toBe("Depends on Experience");
    expect(s.min).toBeUndefined();
    expect(s.max).toBeUndefined();
    expect(s.currency).toBeUndefined();
  });

  test("absent salary yields nothing", () => {
    expect(parseJsonLdSalary({})).toEqual({});
  });
});

describe("toIsoDate", () => {
  test("normalizes a JavaScript Date.toString(), as Jobgether emits", () => {
    expect(toIsoDate("Wed Aug 12 2026 23:30:27 GMT+0000 (Coordinated Universal Time)")).toBe(
      "2026-08-12T23:30:27.000Z"
    );
  });

  test("leaves an existing ISO string untouched", () => {
    expect(toIsoDate("2026-08-12T17:26:16.000Z")).toBe("2026-08-12T17:26:16.000Z");
    expect(toIsoDate("2026-08-12")).toBe("2026-08-12");
  });

  test("drops unparseable input rather than storing it", () => {
    expect(toIsoDate("sometime soon")).toBeUndefined();
    expect(toIsoDate(undefined)).toBeUndefined();
    expect(toIsoDate("")).toBeUndefined();
  });
});

describe("applyJobPosting", () => {
  test("fills company, description and dates from structured data", () => {
    const out = applyJobPosting(base, {
      "@type": "JobPosting",
      title: "AI Architect",
      description: "<p>Build agents.</p>",
      hiringOrganization: { name: "Daman Consulting" },
      employmentType: "CONTRACTOR",
      jobLocationType: "TELECOMMUTE",
      datePosted: "2026-08-12T17:26:16.000Z",
      validThrough: "2026-09-12T17:26:16.000Z",
    });

    expect(out.company).toBe("Daman Consulting");
    expect(out.title).toBe("AI Architect");
    expect(out.description).toBe("<p>Build agents.</p>");
    expect(out.job_type).toBe("contract");
    expect(out.remote_type).toBe("fully_remote");
    expect(out.published_at).toBe("2026-08-12T17:26:16.000Z");
    expect(out.expires_at).toBe("2026-09-12T17:26:16.000Z");
  });

  test("enrichment never blanks a field the listing already supplied", () => {
    const listing: RawJob = { ...base, company: "Listing Co", location: "Berlin" };
    const out = applyJobPosting(listing, { "@type": "JobPosting" });

    expect(out.company).toBe("Listing Co");
    expect(out.title).toBe("Listing Title");
    expect(out.location).toBe("Berlin");
    expect(out.job_type).toBe("full_time");
  });

  test("decodes entities in the employer name", () => {
    const out = applyJobPosting(base, {
      "@type": "JobPosting",
      hiringOrganization: { name: "Ben &amp; Jerry&#39;s" },
    });
    expect(out.company).toBe("Ben & Jerry's");
  });

  test("accepts a plain-string hiringOrganization", () => {
    const out = applyJobPosting(base, {
      "@type": "JobPosting",
      hiringOrganization: "Acme Corp",
    });
    expect(out.company).toBe("Acme Corp");
  });
});
