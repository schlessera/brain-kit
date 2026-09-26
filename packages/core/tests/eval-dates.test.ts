/**
 * `brain eval`'s time-relative answers: a selector over frontmatter dates,
 * resolved at the run's pinned now (set header, then --now, then the clock),
 * and the stale-vs-current `current_first` rate. The real bin on a temp copy
 * of the fixture corpus, keyless, FTS lane.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  mkdirSync(join(root, "evals"), { recursive: true });
});

afterAll(() => cleanup(root));

function writeSet(name: string, lines: object[]): string {
  const path = join(root, "evals", name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

async function evalRun(set: string, ...flags: string[]) {
  const run = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set, ...flags]);
  let out;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    out = undefined;
  }
  return { ...run, out };
}

// The bookshelf project's deadline is 2026-08-15; no other fixture has one.
const DUE_NEXT = {
  id: "due-next",
  q: "what is due next",
  class: "time",
  expect: { select: { field: "deadline", after: "now", order: "asc", take: 1 } },
};

describe("selectors", () => {
  test("the deadline selector resolves to the bookshelf status at the header's now", async () => {
    const { code, out } = await evalRun(writeSet("due.jsonl", [{ now: "2026-07-12" }, DUE_NEXT]));
    expect(out?.per_query?.[0]?.expected).toEqual(["projects/active/bookshelf/status.md"]);
    expect(code).toBe(0);
    expect(out.meta.now).toBe("2026-07-12T00:00:00.000Z");
  });

  test("past the deadline it selects nothing, and the run is refused", async () => {
    const { code, stdout, stderr } = await evalRun(writeSet("due-late.jsonl", [{ now: "2026-09-01" }, DUE_NEXT]));
    expect(stderr).toContain("1 selector(s) select no document");
    expect(stderr).toContain("due-next:");
    expect(code).toBe(2);
    expect(stdout).toBe("");
  });

  test("--now pins the run when the header does not", async () => {
    const set = writeSet("due-flag.jsonl", [DUE_NEXT]);
    const early = await evalRun(set, "--now", "2026-07-12");
    expect(early.out?.per_query?.[0]?.expected).toEqual(["projects/active/bookshelf/status.md"]);
    expect(early.out.meta.now).toBe("2026-07-12T00:00:00.000Z");
    const late = await evalRun(set, "--now", "2026-09-01");
    expect(late.code).toBe(2);
  });

  test("the header wins over --now, and the ignored flag is reported", async () => {
    const { code, out } = await evalRun(writeSet("due-both.jsonl", [{ now: "2026-07-12" }, DUE_NEXT]), "--now", "2026-09-01");
    expect(code).toBe(0);
    expect(out.meta.now).toBe("2026-07-12T00:00:00.000Z");
    expect(out.warnings).toEqual(["--now 2026-09-01 ignored: the set's header pins now to 2026-07-12"]);
  });

  test("type, order and take: the next two context reviews, soonest first", async () => {
    const reviews = {
      id: "reviews",
      q: "what should I review",
      class: "time",
      expect: { select: { type: "context", field: "next_review", after: "now", order: "asc", take: 2 } },
    };
    const { code, out } = await evalRun(writeSet("reviews.jsonl", [{ now: "2026-07-12" }, reviews]));
    expect(code).toBe(0);
    expect(out.per_query[0].expected).toEqual(["context/current-focus.md", "context/reading-list.md"]);
    const latest = { ...reviews, expect: { select: { ...reviews.expect.select, after: undefined, order: "desc", take: 1 } } };
    const desc = await evalRun(writeSet("reviews-desc.jsonl", [{ now: "2026-07-12" }, latest]));
    expect(desc.out.per_query[0].expected).toEqual(["context/reading-list.md"]);
  });

  test("an invalid or impossible --now is a usage error", async () => {
    for (const bad of ["soon", "2026-02-30"]) {
      const { code, stderr } = await evalRun(writeSet("due-bad.jsonl", [DUE_NEXT]), "--now", bad);
      expect(stderr).toContain("--now takes an ISO date");
      expect(code).toBe(2);
    }
  });
});

describe("stale vs current", () => {
  // For "short bio" the fixture ranks the lagging short-bio.md first and its
  // source FACTS.md fourth.
  const BIO = { id: "bio", q: "short bio", class: "stale-vs-current" };

  test("a stale path ranking first reports current_first = 0", async () => {
    const { code, out } = await evalRun(
      writeSet("stale.jsonl", [{ ...BIO, expected: ["me/basics/FACTS.md"], stale: ["me/basics/short-bio.md"] }])
    );
    expect(code).toBe(0);
    expect(out.per_query[0]).toMatchObject({ rank: 4, current_first: false });
    expect(out.rows.find((r: { class: string | null }) => r.class === "stale-vs-current").current_first).toBe(0);
  });

  test("swapping stale and expected reports current_first = 1", async () => {
    const { code, out } = await evalRun(
      writeSet("stale-swapped.jsonl", [{ ...BIO, expected: ["me/basics/short-bio.md"], stale: ["me/basics/FACTS.md"] }])
    );
    expect(code).toBe(0);
    expect(out.per_query[0]).toMatchObject({ rank: 1, current_first: true });
    expect(out.rows.find((r: { class: string | null }) => r.class === "stale-vs-current").current_first).toBe(1);
  });

  test("queries without stale paths report current_first as null", async () => {
    const { out } = await evalRun(writeSet("plain.jsonl", [{ ...BIO, expected: ["me/basics/short-bio.md"] }]));
    expect(out.per_query[0].current_first).toBeNull();
    expect(out.rows.every((r: { current_first: number | null }) => r.current_first === null)).toBe(true);
  });

  test("a stale path that does not exist is refused like an expected one", async () => {
    const { code, stderr } = await evalRun(
      writeSet("stale-missing.jsonl", [{ ...BIO, expected: ["me/basics/FACTS.md"], stale: ["me/basics/gone.md"] }])
    );
    expect(stderr).toContain("bio: me/basics/gone.md");
    expect(code).toBe(2);
  });
});

describe("now reaches search", () => {
  // Two notes whose order flips with the date: the context note wins on BM25
  // but loses recency credit fast; the identity note barely decays.
  let flip: string;
  beforeAll(async () => {
    flip = makeTempBrain();
    const doc = (type: string, title: string, updated: string, body: string) =>
      `---\ntitle: ${title}\ntype: ${type}\ncreated: ${updated}\nupdated: ${updated}\n---\n\n${body}\n`;
    writeFileSync(join(flip, "context", "ferry.md"), doc("context", "Crossing", "2026-07-11", "harbour ferry timetable"));
    writeFileSync(join(flip, "me", "ferry.md"), doc("identity", "Commute", "2026-07-12", "harbour ferry timetable notes"));
    expect((await runCli(flip, ["index", "--json"])).code).toBe(0);
    mkdirSync(join(flip, "evals"), { recursive: true });
  });
  afterAll(() => cleanup(flip));

  test("the pinned now decides the ranking the run scores", async () => {
    const query = { id: "ferry", q: "harbour", class: "exact", expected: ["context/ferry.md"] };
    const run = async (now: string) => {
      const path = join(flip, "evals", `ferry-${now}.jsonl`);
      writeFileSync(path, [{ now }, query].map((l) => JSON.stringify(l)).join("\n"));
      const res = await runCli(flip, ["eval", "--mode", "fts", "--rerank", "heuristic", "--json", "--set", path]);
      expect(res.code).toBe(0);
      return JSON.parse(res.stdout).per_query[0].rank;
    };
    expect(await run("2026-07-12")).toBe(1);
    expect(await run("2028-07-12")).toBe(2);
  });
});

describe("selectors over a brain with notes the indexer skips", () => {
  // An earlier deadline on a draft the indexer skips (no title or type), and
  // one on a note whose date does not exist and YAML rolls into range.
  let messy: string;
  beforeAll(async () => {
    messy = makeTempBrain();
    writeFileSync(join(messy, "notes", "draft.md"), "---\ndeadline: 2026-07-20\n---\n\nhalf an idea\n");
    writeFileSync(
      join(messy, "notes", "typo.md"),
      "---\ntitle: Typo\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\ndeadline: 2026-07-32\n---\n\nbody\n"
    );
    expect((await runCli(messy, ["index", "--json"])).code).toBe(0);
    mkdirSync(join(messy, "evals"), { recursive: true });
  });
  afterAll(() => cleanup(messy));

  test("the deadline selector still resolves to the bookshelf status", async () => {
    const set = join(messy, "evals", "due.jsonl");
    writeFileSync(set, [{ now: "2026-07-12" }, DUE_NEXT].map((l) => JSON.stringify(l)).join("\n"));
    const run = await runCli(messy, ["eval", "--mode", "fts", "--json", "--set", set]);
    let out;
    try {
      out = JSON.parse(run.stdout);
    } catch {
      out = undefined;
    }
    expect(out?.per_query?.[0]?.expected).toEqual(["projects/active/bookshelf/status.md"]);
    expect(run.code).toBe(0);
  });
});
