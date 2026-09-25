/**
 * The pi brain_search tool's date filters and sorts (#454): the same inputs
 * and meanings as the MCP tool (#410), mapped onto core's SearchOptions.
 *
 * The "lantern" docs sit one day either side of each boundary. The "beacon"
 * docs carry the sorts: their text-match order is the reverse of their date
 * order, and every date is years old, so the reranker's recency factor is at
 * its floor for all of them and cannot supply the date order itself.
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeIndexedBrain, resultText, type TempBrain } from "./helpers";

const CTX = {} as never;

const doc = (title: string, updated: string, body: string, deadline?: string) =>
  `---\ntype: note\ntitle: ${title}\ncreated: 2019-01-01\nupdated: ${updated}\ntags: [t]\nstatus: active\nrelevance: secondary\n` +
  (deadline ? `deadline: ${deadline}\n` : "") +
  `---\n\n${body}\n`;

let brain: TempBrain;
let search: ToolDefinition;

beforeAll(async () => {
  brain = await makeIndexedBrain({
    "notes/lantern-a.md": doc("Lantern A", "2020-08-09", "Check the lantern wick.", "2020-10-09"),
    "notes/lantern-b.md": doc("Lantern B", "2020-08-10", "Check the lantern wick.", "2020-10-10"),
    "notes/lantern-c.md": doc("Lantern C", "2020-08-11", "Check the lantern wick.", "2020-10-11"),
    "notes/lantern-far.md": doc("Lantern Far", "2020-08-01", "Check the lantern wick.", "2099-01-01"),
    "notes/lantern-past.md": doc("Lantern Past", "2020-08-01", "Check the lantern wick.", "2000-01-01"),
    "notes/beacon-u.md": doc("Signal U", "2020-05-01", "beacon beacon beacon beacon beacon beacon"),
    "notes/beacon-1.md": doc("Signal 1", "2020-05-02", "beacon beacon beacon beacon", "2020-12-03"),
    "notes/beacon-2.md": doc("Signal 2", "2020-05-03", "beacon beacon", "2020-12-02"),
    "notes/beacon-3.md": doc("Signal 3", "2020-05-04", "beacon", "2020-12-01"),
    // upcoming, against a clock pinned to NOW (2026-07-01): deadlines
    // yesterday, today and tomorrow, and two later ones whose score order
    // (ember-late matches more strongly) is the reverse of their date order.
    "notes/ember-yesterday.md": doc("Ember Y", "2020-05-01", "ember", "2026-06-30"),
    "notes/ember-today.md": doc("Ember T", "2020-05-01", "ember", "2026-07-01"),
    "notes/ember-tomorrow.md": doc("Ember M", "2020-05-01", "ember", "2026-07-02"),
    "notes/ember-soon.md": doc("Ember S", "2020-05-01", "ember", "2026-08-01"),
    "notes/ember-late.md": doc("Ember L", "2020-05-01", "ember ember ember ember ember", "2026-09-01"),
  });
  const list = createBrainTools({
    brain: createBrainAccess(brain.root),
    turn: createTurnContext(),
    lock: toolLockFromKeyed(createKeyedLock()),
  });
  search = list.find((t) => t.name === "brain_search")!;
});

afterAll(() => brain.cleanup());

async function paths(params: Record<string, unknown>): Promise<string[]> {
  const res = await search.execute("s", { limit: 50, ...params } as never, undefined, undefined, CTX);
  return resultText(res)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(" — ")[0]!);
}

const lantern = (params: Record<string, unknown>) => paths({ query: "lantern", ...params });
const beacon = (params: Record<string, unknown> = {}) => paths({ query: "beacon", ...params });

describe("date bounds, each inclusive", () => {
  test("updated_since includes its own date", async () => {
    expect(await lantern({ updated_since: "2020-08-10" })).toContain("notes/lantern-b.md");
  });
  test("updated_since excludes the day before", async () => {
    expect(await lantern({ updated_since: "2020-08-10" })).not.toContain("notes/lantern-a.md");
  });
  test("updated_before includes its own date", async () => {
    expect(await lantern({ updated_before: "2020-08-10" })).toContain("notes/lantern-b.md");
  });
  test("updated_before excludes the day after", async () => {
    expect(await lantern({ updated_before: "2020-08-10" })).not.toContain("notes/lantern-c.md");
  });
  test("deadline_from includes its own date", async () => {
    expect(await lantern({ deadline_from: "2020-10-10" })).toContain("notes/lantern-b.md");
  });
  test("deadline_from excludes the day before", async () => {
    expect(await lantern({ deadline_from: "2020-10-10" })).not.toContain("notes/lantern-a.md");
  });
  test("deadline_to includes its own date", async () => {
    expect(await lantern({ deadline_to: "2020-10-10" })).toContain("notes/lantern-b.md");
  });
  test("deadline_to excludes the day after", async () => {
    expect(await lantern({ deadline_to: "2020-10-10" })).not.toContain("notes/lantern-c.md");
  });
});

describe("sorts", () => {
  test("the premise: score order runs opposite to date order", async () => {
    expect(await beacon()).toEqual(["notes/beacon-u.md", "notes/beacon-1.md", "notes/beacon-2.md", "notes/beacon-3.md"]);
  });
  test("sort deadline lists the earliest deadline first", async () => {
    expect((await beacon({ sort: "deadline" })).slice(0, 3)).toEqual(["notes/beacon-3.md", "notes/beacon-2.md", "notes/beacon-1.md"]);
  });
  test("sort deadline lists an undated doc last", async () => {
    expect((await beacon({ sort: "deadline" })).at(-1)).toBe("notes/beacon-u.md");
  });
  test("sort updated lists the newest first", async () => {
    expect(await beacon({ sort: "updated" })).toEqual(["notes/beacon-3.md", "notes/beacon-2.md", "notes/beacon-1.md", "notes/beacon-u.md"]);
  });
});

describe("upcoming", () => {
  const NOW = new Date("2026-07-01T12:00:00Z");
  async function upcoming(params: Record<string, unknown> = {}) {
    setSystemTime(NOW);
    try {
      return await paths({ query: "ember", upcoming: true, ...params });
    } finally {
      setSystemTime();
    }
  }

  test("the premise: score order puts the later deadline first", async () => {
    const ranked = await paths({ query: "ember" });
    expect(ranked.indexOf("notes/ember-late.md")).toBeLessThan(ranked.indexOf("notes/ember-soon.md"));
  });
  test("excludes a deadline yesterday", async () => {
    expect(await upcoming()).not.toContain("notes/ember-yesterday.md");
  });
  test("includes a deadline today", async () => {
    expect(await upcoming()).toContain("notes/ember-today.md");
  });
  test("lists every deadline from today on, earliest first", async () => {
    expect(await upcoming()).toEqual([
      "notes/ember-today.md", "notes/ember-tomorrow.md", "notes/ember-soon.md", "notes/ember-late.md",
    ]);
  });
  test("an explicit deadline_from wins over today", async () => {
    expect(await upcoming({ deadline_from: "2026-07-02" })).toEqual([
      "notes/ember-tomorrow.md", "notes/ember-soon.md", "notes/ember-late.md",
    ]);
  });
  test("an explicit sort wins over the deadline sort", async () => {
    const ranked = await upcoming({ sort: "score" });
    expect(ranked.indexOf("notes/ember-late.md")).toBeLessThan(ranked.indexOf("notes/ember-soon.md"));
  });
});

describe("the registered schema", () => {
  const schema = () => JSON.parse(JSON.stringify(search.parameters)) as {
    required: string[];
    properties: Record<string, { type?: string; description?: string; anyOf?: { const: string }[] }>;
  };

  test("adds the six date inputs, each optional and described", () => {
    const { required, properties } = schema();
    expect(required).toEqual(["query"]);
    for (const key of ["updated_since", "updated_before", "deadline_from", "deadline_to"]) {
      expect({ key, type: properties[key]?.type }).toEqual({ key, type: "string" });
      expect(properties[key]?.description).toContain("YYYY-MM-DD");
    }
    expect(properties.upcoming?.type).toBe("boolean");
    expect(properties.upcoming?.description).toContain("deadline_from today");
  });

  test("sort is an enum of score, updated and deadline", () => {
    const { properties } = schema();
    expect(properties.sort?.anyOf?.map((option) => option.const)).toEqual(["score", "updated", "deadline"]);
    expect(properties.sort?.description).toContain("earliest first");
  });
});

describe("invalid input is a tool error", () => {
  for (const value of ["2026-02-30", "next tuesday"]) {
    test(`deadline_from ${JSON.stringify(value)}`, async () => {
      await expect(
        search.execute("s", { query: "lantern", deadline_from: value } as never, undefined, undefined, CTX)
      ).rejects.toThrow("deadline_from must be a date written YYYY-MM-DD");
    });
  }
  test("an unknown sort", async () => {
    await expect(
      search.execute("s", { query: "lantern", sort: "newest" } as never, undefined, undefined, CTX)
    ).rejects.toThrow("sort must be one of");
  });
});
