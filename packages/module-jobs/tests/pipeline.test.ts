/**
 * The job pipeline as frontmatter (#405): `jobs scaffold` writes the stage,
 * `jobs pipeline` gives the opportunities' `_index.md` a registry spec and
 * renders its Active and Closed tables, and the hygiene checks flag an
 * opportunity with no stage or one left researching.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { parseFrontmatter } from "../src/lib/frontmatter-parse";

import { bindContentIndexQueries } from "../../core/src/queries/bound";
import { openDatabase } from "../src/db";
import { checkOpportunityStages, ensurePipelineIndex } from "../src/pipeline";
import { ingestJobs } from "../src/scrape";

const BRAIN_BIN = resolve(import.meta.dir, "../../core/src/cli/brain.ts");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

async function brain(root: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", BRAIN_BIN, ...args], {
    env: { ...process.env, BRAIN_ROOT: root, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function makeBrain(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "jobs-pipeline-"));
  roots.push(root);
  symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(root, "node_modules"));
  writeFileSync(
    join(root, "brain.config.json"),
    JSON.stringify({ modules: { "@schlessera/brain-module-jobs": { criteria: "criteria.md" } } })
  );
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const opportunity = (company: string, stage: string | null, updated = "2026-06-01", extra = "") =>
  `---\ntype: opportunity\ntitle: "${company} — Engineer"\ncreated: 2026-05-01\nupdated: ${updated}\n` +
  `tags: [job-search]\nstatus: active\nrelevance: primary\n${stage ? `stage: ${stage}\n` : ""}${extra}---\n\n## Overview\n`;

describe("jobs scaffold", () => {
  test("writes stage: researching, tags [job-search] and the research sections", async () => {
    const root = makeBrain();
    const db = openDatabase(join(root, "jobs.db"));
    ingestJobs(db, [
      {
        source: "remoteok",
        source_id: "1",
        title: "Trail Systems Engineer",
        company: "Ridge Works",
        url: "https://jobs.example/ridge-works/1",
      },
    ]);
    const id = (db.query("SELECT id FROM jobs").get() as { id: number }).id;
    db.close();

    const { code, stderr } = await brain(root, "jobs", "scaffold", String(id), "--json");
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const text = readFileSync(join(root, "career/opportunities/ridge-works/status.md"), "utf8");
    const data = parseFrontmatter(text).data;
    expect(data.stage).toBe("researching");
    expect(data.tags).toEqual(["job-search"]);
    for (const section of ["Overview", "Fit Assessment", "Materials Sent", "Contacts", "Timeline", "Notes", "Full Job Description"]) {
      expect(text).toContain(`\n## ${section}\n`);
    }
  });
});

describe("jobs pipeline", () => {
  const FILES = {
    "career/opportunities/aspen/status.md": opportunity("Aspen", "researching", "2026-06-10"),
    "career/opportunities/birch/status.md": opportunity("Birch", "interviewing", "2026-06-20", "next_step: Panel interview\ndeadline: 2026-07-02\n"),
    "career/opportunities/birch/research.md": `---\ntype: opportunity\ntitle: "Birch — Research"\ncreated: 2026-05-01\nupdated: 2026-06-01\ntags: [job-search]\n---\n\nNotes.\n`,
    "career/opportunities/cedar/status.md": opportunity("Cedar", "closed", "2026-05-15", "closed_reason: Role filled\n"),
  };
  const INDEX = "career/opportunities/_index.md";

  const tables = (text: string) => {
    const region = text.split("<!-- brain:generated:registry -->")[1]!.split("<!-- /brain:generated:registry -->")[0]!;
    const table = (label: string) => {
      const after = region.split(`**${label}**`)[1];
      if (after === undefined) return [];
      return after.split("\n**")[0]!.split("\n").filter((l) => l.startsWith("| [["));
    };
    return { active: table("Active"), closed: table("Closed") };
  };

  test("adds the registry spec to an existing index and writes Active and Closed tables, prose untouched", async () => {
    const prose = "Where I track applications. Hand-written notes stay put.\n";
    const head = `---\ntype: index\ntitle: "Pipeline"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [job-search] # kept as written\n`;
    const root = makeBrain({ ...FILES, [INDEX]: `${head}---\n\n${prose}` });
    const { code, stderr } = await brain(root, "jobs", "pipeline", "--json");
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

    const text = readFileSync(join(root, INDEX), "utf8");
    // Every byte of the old frontmatter survives, the spec appended after it;
    // only `updated` moves, because the region changed.
    expect(text.replace(/^updated: \S+$/m, "updated: 2026-01-01").startsWith(`${head}registry:\n`)).toBe(true);
    expect(text).toContain(`\n---\n\n${prose}\n<!-- brain:generated:registry -->`);
    const { active, closed } = tables(text);
    expect(active.length).toBeGreaterThan(0);
    expect(closed.length).toBeGreaterThan(0);
    expect(active).toEqual([
      "| [[career/opportunities/birch/status]] | interviewing | — | Panel interview | 2026-07-02 | 2026-06-20 |",
      "| [[career/opportunities/aspen/status]] | researching | — | — | — | 2026-06-10 |",
    ]);
    expect(closed).toEqual(["| [[career/opportunities/cedar/status]] | closed | — | — | — | 2026-05-15 |"]);
  });

  test("creates the index when there is none, and a second run changes nothing", async () => {
    const root = makeBrain(FILES);
    expect((await brain(root, "jobs", "pipeline")).code).toBe(0);
    const first = readFileSync(join(root, INDEX), "utf8");
    expect(tables(first).active).toHaveLength(2);
    const again = JSON.parse((await brain(root, "jobs", "pipeline", "--json")).stdout);
    expect(again).toMatchObject({ spec: "kept", written: [] });
    expect(readFileSync(join(root, INDEX), "utf8")).toBe(first);
    // From then on, `brain registry` keeps it current.
    writeFileSync(join(root, "career/opportunities/aspen/status.md"), opportunity("Aspen", "closed", "2026-06-25"));
    expect((await brain(root, "registry")).code).toBe(0);
    expect(tables(readFileSync(join(root, INDEX), "utf8")).closed).toHaveLength(2);
  });
});

describe("jobs pipeline refuses to guess", () => {
  const INDEX = "career/opportunities/_index.md";

  test("an index whose frontmatter never closes is reported and left as it is", async () => {
    const broken = "---\ntype: index\ntitle: Pipeline\n\nThe fence above is never closed.\n";
    const root = makeBrain({ [INDEX]: broken });
    const { code, stderr } = await brain(root, "jobs", "pipeline");
    expect(code).not.toBe(0);
    expect(stderr).toContain("frontmatter has no closing --- line");
    expect(readFileSync(join(root, INDEX), "utf8")).toBe(broken);
  });

  test.each([
    ["a flow mapping", "---\n{type: index, title: Pipeline}\n---\nNotes.\n"],
    ["a `...` document end", "---\ntype: index\ntitle: Pipeline\n...\n---\nNotes.\n"],
  ])("frontmatter written as %s is refused, its bytes untouched", async (_, text) => {
    // The premise: the index is valid as it stands.
    expect(parseFrontmatter(text).data).toMatchObject({ type: "index", title: "Pipeline" });
    const root = makeBrain({ [INDEX]: text });
    const { code, stderr } = await brain(root, "jobs", "pipeline");
    expect(readFileSync(join(root, INDEX), "utf8")).toBe(text);
    expect(code).not.toBe(0);
    expect(stderr).toContain("its frontmatter layout cannot take the registry spec");
  });

  test("a symlinked parent that leaves the brain gets no directory made outside it", async () => {
    const root = makeBrain();
    const outside = mkdtempSync(join(tmpdir(), "jobs-outside-"));
    roots.push(outside);
    symlinkSync(outside, join(root, "career"));
    const { code, stderr } = await brain(root, "jobs", "pipeline");
    expect(readdirSync(outside)).toEqual([]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("leaves the brain root");
  });

  test("an index edited between the read and the write is not overwritten", () => {
    const original = `---\ntype: index\ntitle: Pipeline\n---\n\nNotes.\n`;
    const edited = `${original}A line saved meanwhile.\n`;
    const root = makeBrain({ [INDEX]: original });
    const full = join(root, INDEX);
    const real = fs.readFileSync;
    let reads = 0;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      // The second read of the index is the check before the write: the file
      // was saved in between.
      if (String(path) === full && ++reads === 2) writeFileSync(full, edited);
      return (real as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    try {
      expect(() => ensurePipelineIndex(root, "career/opportunities", "2026-07-01")).toThrow("changed while the registry spec was being added");
    } finally {
      spy.mockRestore();
    }
    expect(reads).toBe(2);
    expect(readFileSync(full, "utf8")).toBe(edited);
  });
});

describe("hygiene checks", () => {
  async function issues(files: Record<string, string>, now: Date) {
    const root = makeBrain(files);
    expect((await brain(root, "index", "--json")).code).toBe(0);
    return checkOpportunityStages({ queries: bindContentIndexQueries(root), root, config: {} as never }, now);
  }
  const NOW = new Date("2026-09-01T12:00:00Z");

  test("an opportunity without a stage is flagged, one with a stage is not", async () => {
    const found = await issues(
      {
        "career/opportunities/aspen/status.md": opportunity("Aspen", null, "2026-08-30"),
        "career/opportunities/birch/status.md": opportunity("Birch", "applied", "2026-08-30"),
      },
      NOW
    );
    expect(found).toEqual([
      expect.objectContaining({ path: "career/opportunities/aspen/status.md", severity: "info", message: "Opportunity has no `stage`" }),
    ]);
  });

  test("researching untouched for over 60 days is flagged; recent or advanced ones are not", async () => {
    const found = await issues(
      {
        "career/opportunities/old/status.md": opportunity("Old", "researching", "2026-06-01"),
        "career/opportunities/new/status.md": opportunity("New", "researching", "2026-08-20"),
        "career/opportunities/moved/status.md": opportunity("Moved", "interviewing", "2026-06-01"),
      },
      NOW
    );
    expect(found.map((i) => i.path)).toEqual(["career/opportunities/old/status.md"]);
    expect(found[0]).toMatchObject({ severity: "info", category: "jobs-stage" });
    expect(found[0].message).toContain("92 days");
  });

  test("brain audit reports the checks through the module", async () => {
    const root = makeBrain({ "career/opportunities/aspen/status.md": opportunity("Aspen", null) });
    expect((await brain(root, "index", "--json")).code).toBe(0);
    const out = JSON.parse((await brain(root, "audit", "--json")).stdout);
    expect(out.issues).toContainEqual(expect.objectContaining({ path: "career/opportunities/aspen/status.md", category: "jobs-stage" }));
  });
});

describe("the skills", () => {
  const read = (skill: string) => readFileSync(join(import.meta.dir, "../skills", skill, "SKILL.md"), "utf-8");
  test.each(["research-opportunity", "interview-scheduled"])("%s records the stage in frontmatter and never edits the index table", (skill) => {
    const text = read(skill);
    expect(text).not.toContain("next_step_date");
    expect(text).toContain("stage:");
    expect(text).toContain("brain jobs pipeline");
    // No step adds or edits a row of the pipeline table.
    expect(text).not.toMatch(/add a row|row's Status|Update the pipeline index/i);
  });

  test("closing clears the next step and its deadline, and retires a prep file's, keeping them as history", () => {
    const closing = read("research-opportunity").split("**Closing**")[1]!.split("\n## ")[0]!;
    expect(closing).toContain("Remove `next_step` and `deadline` from `status.md`");
    expect(closing).toContain("Timeline line");
    expect(closing).toMatch(/interview-prep\.md.*remove its `deadline:`/s);
    // interview-scheduled closes through those steps rather than its own.
    const after = read("interview-scheduled").split("**After**")[1]!.split("\n## ")[0]!;
    expect(after).toContain("**Closing** steps");
    expect(after).not.toMatch(/stage: closed` with a `closed_reason`/);
  });
});
