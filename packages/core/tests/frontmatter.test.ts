import { describe, expect, test } from "bun:test";
import matter from "gray-matter";

import { normalizeFrontmatterDates, stringifyDocument } from "../src/lib/frontmatter";

// A representative brain file: unquoted YAML dates (which gray-matter parses
// into Date objects) and inline flow-style tag arrays.
const SOURCE = `---
type: career
title: Example Opportunity
created: 2026-03-06
updated: 2026-05-14
deadline: 2026-07-07
tags: [job-search, agentic, interviews]
aliases: [A.Team, ATeam]
status: active
relevance: primary
summary: One-line summary for search results
---

## Timeline

- 2026-07-07 — eval call
`;

describe("stringifyDocument round-trip", () => {
  const parsed = matter(SOURCE);
  const output = stringifyDocument(parsed.content, parsed.data);

  test("gray-matter parses unquoted dates as Date objects (precondition)", () => {
    expect(parsed.data.created).toBeInstanceOf(Date);
  });

  test("dates stay YYYY-MM-DD, never ISO timestamps", () => {
    expect(output).toContain("created: 2026-03-06");
    expect(output).toContain("updated: 2026-05-14");
    expect(output).toContain("deadline: 2026-07-07");
    expect(output).not.toContain("T00:00:00");
  });

  test("tag and alias arrays stay inline flow style", () => {
    expect(output).toContain("tags: [job-search, agentic, interviews]");
    expect(output).toContain("aliases: [A.Team, ATeam]");
  });

  test("body content survives unchanged", () => {
    expect(output).toContain("## Timeline");
    expect(output).toContain("- 2026-07-07 — eval call");
  });

  test("output re-parses to equivalent data", () => {
    const reparsed = matter(output);
    expect(String(reparsed.data.title)).toBe("Example Opportunity");
    expect(reparsed.data.tags).toEqual(["job-search", "agentic", "interviews"]);
    // Dates parse back to Date objects pointing at the same day
    expect((reparsed.data.created as Date).toISOString()).toStartWith("2026-03-06");
  });
});

describe("normalizeFrontmatterDates", () => {
  test("converts Date values to YYYY-MM-DD strings", () => {
    const normalized = normalizeFrontmatterDates({
      created: new Date("2026-03-06T00:00:00.000Z"),
      title: "X",
    });
    expect(normalized.created).toBe("2026-03-06");
    expect(normalized.title).toBe("X");
  });

  test("converts Dates inside arrays and leaves other values alone", () => {
    const normalized = normalizeFrontmatterDates({
      dates: [new Date("2026-01-02T00:00:00.000Z"), "keep"],
      tags: ["a", "b"],
      count: 3,
    });
    expect(normalized.dates).toEqual(["2026-01-02", "keep"]);
    expect(normalized.tags).toEqual(["a", "b"]);
    expect(normalized.count).toBe(3);
  });
});
