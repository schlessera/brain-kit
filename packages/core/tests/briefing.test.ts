/**
 * `brain briefing`'s Upkeep section (the content-hygiene log) and the cap on
 * Overdue Reviews (#395). Briefing reads the wall clock, so each brain is
 * briefed in-process with the clock pinned to NOW.
 */

import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { generateBriefing, type BriefingOptions } from "../src/cli/commands/briefing";
import { initContext } from "../src/lib/context";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const DAY = 86_400_000;
const NOW = new Date("2026-07-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

const brains: string[] = [];
afterAll(() => {
  for (const dir of brains) cleanup(dir);
});

async function makeBrain(files: Record<string, string>, fromCorpus = false): Promise<string> {
  const root = makeTempBrain({ empty: !fromCorpus });
  brains.push(root);
  if (!fromCorpus) writeFileSync(join(root, "brain.config.json"), "{}");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  // The copies' mtimes are today's; keep Silently Modified out of the picture.
  expect((await runCli(root, ["accept-mtime", "--json"])).code).toBe(0);
  return root;
}

async function brief(root: string, opts: BriefingOptions = {}): Promise<string> {
  const brain = await initContext({ root });
  setSystemTime(NOW);
  try {
    return await generateBriefing(brain, 15, opts);
  } finally {
    setSystemTime();
  }
}

function section(briefing: string, name: string): string[] {
  const body = briefing.split(`\n## ${name}\n`)[1];
  if (body === undefined) return [];
  return body.split("\n## ")[0]!.split("\n").filter((line) => line.startsWith("- "));
}

/** These log-specific assertions leave the independently tested audit line out. */
function hygieneLines(briefing: string): string[] {
  return section(briefing, "Upkeep").filter((line) => !line.includes("must-fix audit finding(s)"));
}

const note = (title: string) =>
  `---\ntype: note\ntitle: "${title}"\ncreated: 2026-01-01\nupdated: 2026-06-30\ntags: [t]\nrelevance: primary\n---\n\nBody.\n`;

const hygiene = (title: string, body: string) =>
  `---\ntype: context\ntitle: "${title}"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [hygiene]\n---\n\n${body}`;

const OPEN = hygiene(
  "Hygiene — Open Issues",
  "## Staleness\n\n### stale-1\nx\n\n### stale-2\ny\n\n## Orphans\n\n### orphan-1\nz\n\n```md\n### not an entry\n```\n"
);
const lastRun = (day: string) => hygiene("Hygiene — Last Run", `## Last run: ${day}T09:30:00Z\n\n- Auto-fixed: 0\n`);

describe("Upkeep", () => {
  test("shows the last hygiene run, its age, overdue past 10 days, and the open entries", async () => {
    const root = await makeBrain({
      "context/hygiene/open.md": OPEN,
      "context/hygiene/last-run.md": lastRun(daysAgo(20)),
    });
    expect(hygieneLines(await brief(root))).toEqual([
      `- content-hygiene last ran ${daysAgo(20)}, 20 day(s) ago (overdue)`,
      "- 3 open (context/hygiene/open.md)",
    ]);
  });

  test("a recent run is not overdue", async () => {
    const root = await makeBrain({
      "context/hygiene/open.md": OPEN,
      "context/hygiene/last-run.md": lastRun(daysAgo(10)),
    });
    expect(hygieneLines(await brief(root))[0]).toBe(`- content-hygiene last ran ${daysAgo(10)}, 10 day(s) ago`);
  });

  test("an open.md with no last-run.md still shows, and says no run is recorded", async () => {
    const root = await makeBrain({ "context/hygiene/open.md": OPEN });
    expect(hygieneLines(await brief(root))).toEqual([
      "- content-hygiene has no recorded run (context/hygiene/last-run.md)",
      "- 3 open (context/hygiene/open.md)",
    ]);
  });

  test("a brain with no hygiene log includes its audit count in the reviewed corpus briefing", async () => {
    const root = await makeBrain({}, true);
    const golden = readFileSync(join(import.meta.dir, "fixtures/briefing-corpus.golden.txt"), "utf-8");
    expect((await brief(root)) + "\n").toBe(golden);
  });
});

describe("Overdue Reviews", () => {
  const reviewed = (n: number) =>
    `---\ntype: note\ntitle: "Review ${n}"\ncreated: 2026-01-01\nupdated: 2026-06-30\nnext_review: ${daysAgo(n)}\ntags: [t]\n---\n\nBody.\n`;
  // Seven overdue reviews, due 1 to 7 days ago; written newest first so the
  // file order is not the answer.
  const SEVEN = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`notes/r${n}.md`, reviewed(n)]));

  test("lists the five oldest, then how many more", async () => {
    const lines = section(await brief(await makeBrain(SEVEN)), "Overdue Reviews");
    expect(lines).toEqual([
      ...[7, 6, 5, 4, 3].map((n) => `- ${daysAgo(n)} | notes/r${n}.md | Review ${n}`),
      "- … and 2 more (brain audit)",
    ]);
  });

  test("reviewLimit overrides the cap", async () => {
    const lines = section(await brief(await makeBrain(SEVEN), { reviewLimit: 7 }), "Overdue Reviews");
    expect(lines).toHaveLength(7);
    expect(lines.some((l) => l.includes("more (brain audit)"))).toBe(false);
  });

  test("--limit-reviews reaches the briefing, and must be a non-negative integer", async () => {
    // Dates long past, so the real clock the CLI reads still finds them overdue.
    const old = (n: number) =>
      `---\ntype: note\ntitle: "Old ${n}"\ncreated: 2020-01-01\nupdated: 2020-01-01\nnext_review: 2020-01-0${n}\ntags: [t]\n---\n\nBody.\n`;
    const root = await makeBrain(Object.fromEntries([1, 2, 3].map((n) => [`notes/o${n}.md`, old(n)])));
    const { stdout, code } = await runCli(root, ["briefing", "--limit-reviews", "1"]);
    expect(code).toBe(0);
    expect(section(stdout, "Overdue Reviews")).toEqual(["- 2020-01-01 | notes/o1.md | Old 1", "- … and 2 more (brain audit)"]);
    for (const bad of ["-1", "1.5", "x"]) {
      expect((await runCli(root, ["briefing", "--limit-reviews", bad])).code).toBe(1);
    }
  });
});

describe("review round 1", () => {
  test("malformed hygiene metadata is reported and the rest of the briefing still comes", async () => {
    const cases: Array<[string, Record<string, string>, string[]]> = [
      [
        "an impossible day in the heading falls back to updated",
        { "context/hygiene/last-run.md": `---\ntype: context\ntitle: L\nupdated: ${daysAgo(3)}\n---\n\n## Last run: 2026-13-01\n` },
        [`- content-hygiene last ran ${daysAgo(3)}, 3 day(s) ago`],
      ],
      [
        "an impossible heading and an impossible updated leave no recorded run",
        { "context/hygiene/last-run.md": '---\ntype: context\ntitle: L\nupdated: "2026-01-32"\n---\n\n## Last run: 2026-13-01\n' },
        ["- content-hygiene has no recorded run (context/hygiene/last-run.md)"],
      ],
      [
        "YAML that does not parse",
        {
          "context/hygiene/last-run.md": "---\ntype: context\ntags: [\n---\n\n## Last run: 2026-06-01\n",
          "context/hygiene/open.md": "---\ntype: context\ntags: [\n---\n\n### one\n",
        },
        [
          "- content-hygiene last run could not be read (context/hygiene/last-run.md)",
          "- open entries could not be counted (context/hygiene/open.md)",
        ],
      ],
    ];
    for (const [name, files, expected] of cases) {
      // A throw is caught into the text, so an aborted briefing fails the
      // assertions below instead of the test harness.
      const briefing = await brief(await makeBrain({ ...files, "notes/a.md": note("A") })).catch(
        (e: Error) => `briefing threw: ${e.message}`
      );
      expect({ name, upkeep: hygieneLines(briefing) }).toEqual({ name, upkeep: expected });
      const recent = section(briefing, "Recently Active").some((l) => l.includes("notes/a.md"));
      expect({ name, recent }).toEqual({ name, recent: true });
    }
  });

  test("a review due today is not overdue, as in brain audit", async () => {
    const reviewedOn = (day: string) =>
      `---\ntype: note\ntitle: "Due ${day}"\ncreated: 2026-01-01\nupdated: 2026-06-30\nnext_review: ${day}\ntags: [t]\n---\n\nBody.\n`;
    const lines = section(
      await brief(await makeBrain({ "notes/today.md": reviewedOn(daysAgo(0)), "notes/yesterday.md": reviewedOn(daysAgo(1)) })),
      "Overdue Reviews"
    );
    expect(lines).toEqual([`- ${daysAgo(1)} | notes/yesterday.md | Due ${daysAgo(1)}`]);
  });

  test("brain audit lists every review the cap leaves out", async () => {
    const reviewed = (n: number) =>
      `---\ntype: note\ntitle: "Review ${n}"\ncreated: 2026-01-01\nupdated: 2026-06-30\nnext_review: ${daysAgo(n)}\ntags: [t]\n---\n\nBody.\n`;
    const root = await makeBrain(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`notes/r${n}.md`, reviewed(n)])));
    const listed = section(await brief(root), "Overdue Reviews").filter((l) => !l.includes("more (brain audit)"));
    const { stdout } = await runCli(root, ["audit", "--json"]);
    const audited = new Set(
      (JSON.parse(stdout).issues as Array<{ path: string; category: string }>)
        .filter((i) => i.category === "review-overdue")
        .map((i) => i.path)
    );
    const omitted = [1, 2].map((n) => `notes/r${n}.md`);
    expect(listed.some((l) => omitted.some((p) => l.includes(p)))).toBe(false);
    for (const path of omitted) expect(audited.has(path)).toBe(true);
  });

  test("open entries inside a longer fence, or after a fake closing line, are not counted", async () => {
    const open = (body: string) => hygiene("Hygiene — Open Issues", body);
    const cases = [
      "### one\n\n````md\n```\n### sample only\n```\n````\n\n### two\n",
      "### one\n\n```\n```not-a-close\n### sample only\n```\n\n### two\n",
    ];
    for (const body of cases) {
      const root = await makeBrain({ "context/hygiene/open.md": open(body) });
      expect(section(await brief(root), "Upkeep")).toContain("- 2 open (context/hygiene/open.md)");
    }
  });
});
