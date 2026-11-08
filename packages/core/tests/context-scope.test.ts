/**
 * Caller path scope in `assembleContext` (#3644). The fixture makes
 * `context/current-focus.md` and `projects/_index.md` canonical, relevant and
 * linked candidates for one query; an exclusion must keep both out of every
 * lane (the canonical slot, the search pool and its section expansion, and
 * the related neighbours), and neither file may be opened. Sentinel spies on
 * the file-open calls record every attempt.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "fs";
import { realpathSync, symlinkSync } from "fs";
import { join, resolve } from "path";

import { initContext, type BrainContext } from "../src/lib/context";
import {
  assembleContext,
  coverageNote,
  emptyAssembleReport,
  emptyContextCoverage,
  estimateTokens,
  type AssembleOptions,
} from "../src/lib/context-assembler";
import { MAX_SCOPE_ENTRIES, parseContextScope, scopeEntryError } from "../src/lib/context-scope";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { readDocument } from "../src/lib/ops/read";
import { FOCUS, FOCUS_MARKER, makeScopeBrain, REGISTRY, REGISTRY_MARKER, SCOPE_QUERY } from "./helpers/context-scope-fixture";

const NOW = new Date("2026-07-12");
let brain: ReturnType<typeof makeScopeBrain>;
let ctx: BrainContext;
let db: Database;

beforeAll(async () => {
  brain = makeScopeBrain();
  ctx = await initContext({ root: brain.root });
  db = openDatabase(ctx.dbPath);
  await indexAll(db, { root: brain.root, taxonomy: ctx.taxonomy, quiet: true });
});

afterAll(() => {
  db?.close();
  brain?.cleanup();
});

/** Every attempt to open or read one of `watched` while `run` runs, by real path as well as spelling. */
async function opensDuring<T>(watched: string[], run: () => Promise<T>): Promise<{ result: T; opened: string[] }> {
  const opened: string[] = [];
  const record = (target: unknown) => {
    if (typeof target !== "string") return;
    const given = resolve(target);
    let real = given;
    try { real = realpathSync(given); } catch { /* missing still counts */ }
    for (const rel of watched) if (given.endsWith(`/${rel}`) || real.endsWith(`/${rel}`)) opened.push(rel);
  };
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  const spies = [
    spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      record(path);
      return (readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync),
    spyOn(fs, "openSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      record(path);
      return (openSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.openSync),
  ];
  try {
    return { result: await run(), opened };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const assemble = (opts: Partial<AssembleOptions>) => {
  const report = emptyAssembleReport();
  const coverage = emptyContextCoverage();
  return assembleContext(db, ctx, { query: SCOPE_QUERY, maxTokens: 4000, now: NOW, report, coverage, ...opts }).then((text) => ({
    text,
    report,
    coverage,
  }));
};

const EXCLUDED = { exclude: [FOCUS, REGISTRY] };

describe("the fixture's premise, unscoped", () => {
  test("the focus is the canonical current focus and the registry a hit or a neighbour", async () => {
    const { text, report } = await assemble({});
    expect(report.focus).toBe(FOCUS);
    expect(text).toContain(FOCUS_MARKER);
    expect([...report.results, ...report.related]).toContain(REGISTRY);
  });

  test("with the canonical slot off, the focus still returns as a hit, and the registry is a neighbour of a hit", async () => {
    const { report } = await assemble({ includeCurrentFocus: false, includeIdentity: false });
    expect(report.focus).toBeNull();
    expect(report.results).toContain(FOCUS);
    expect(report.results).toContain("projects/active/sail-repairs/status.md");
  });

  test("with the registry out of the pool, it still reaches the briefing as a related neighbour", async () => {
    // The registry's own text never ranks: only the neighbour lane can bring it in.
    const { report } = await assemble({ query: "spliced practice spars below the cave", includeCurrentFocus: false, includeIdentity: false });
    expect(report.related.includes(REGISTRY) || report.results.includes(REGISTRY)).toBe(true);
  });
});

describe("an exclusion holds in every lane", () => {
  test("canonical lane: an excluded current focus is neither opened nor returned", async () => {
    const { result, opened } = await opensDuring([FOCUS], () => assemble({ scope: { exclude: [FOCUS] } }));
    expect(result.report.focus, "CANONICAL_FOCUS_EXCLUDED").toBeNull();
    expect(result.text).not.toContain("## Current Focus");
    expect(result.text).not.toContain(FOCUS_MARKER);
    expect(opened, "CANONICAL_FOCUS_NOT_OPENED").toEqual([]);
  });

  test("search lane: with the canonical slot off, neither excluded file is a hit, expanded or opened, at any budget", async () => {
    for (const maxTokens of [300, 900, 4000, 12000]) {
      const { result, opened } = await opensDuring([FOCUS, REGISTRY], () =>
        assemble({ maxTokens, includeCurrentFocus: false, scope: EXCLUDED })
      );
      expect({ maxTokens, results: result.report.results.filter((p) => p === FOCUS || p === REGISTRY) }, "SEARCH_EXCLUDED").toEqual({ maxTokens, results: [] });
      expect(result.text).not.toContain(FOCUS_MARKER);
      expect(result.text).not.toContain(`(${FOCUS})`);
      expect(opened, "SEARCH_NOT_OPENED").toEqual([]);
    }
  });

  test("neighbour lane: an excluded registry is never a related line", async () => {
    for (const query of [SCOPE_QUERY, "spliced practice spars below the cave"]) {
      const { result, opened } = await opensDuring([REGISTRY], () =>
        assemble({ query, maxTokens: 12000, includeCurrentFocus: false, scope: { exclude: [REGISTRY] } })
      );
      expect({ query, related: result.report.related }, "NEIGHBOUR_EXCLUDED").not.toEqual({ query, related: expect.arrayContaining([REGISTRY]) });
      expect(result.text).not.toContain(`(${REGISTRY})`);
      expect(result.text).not.toContain(REGISTRY_MARKER);
      expect(opened).toEqual([]);
    }
  });

  test("both excluded together: nothing from either reaches any lane", async () => {
    const { result, opened } = await opensDuring([FOCUS, REGISTRY], () => assemble({ maxTokens: 12000, scope: EXCLUDED }));
    expect(opened).toEqual([]);
    for (const marker of [FOCUS_MARKER, REGISTRY_MARKER, `(${FOCUS})`, `(${REGISTRY})`]) expect(result.text).not.toContain(marker);
    expect(result.report.focus).toBeNull();
    // The rest of the briefing stands.
    expect(result.report.results).toContain("projects/active/sail-repairs/status.md");
    expect(result.coverage.excerpts.map((e) => e.path)).not.toContain(FOCUS);
  });
});

describe("aliases cannot bypass the scope", () => {
  test("an exclusion matches under case and compatibility folding", async () => {
    const { result, opened } = await opensDuring([FOCUS], () => assemble({ scope: { exclude: ["Context/Current-Focus.md"] } }));
    expect(result.report.focus).toBeNull();
    expect(result.text).not.toContain(FOCUS_MARKER);
    expect(opened).toEqual([]);
  });

  test("a canonical current focus reached through an in-repo symlink is still excluded", async () => {
    const link = "notes/focus-alias.md";
    symlinkSync(join(brain.root, FOCUS), join(brain.root, link));
    // The brain's canonical current focus is the link, not the file it names.
    const taxonomy = new Proxy(ctx.taxonomy, {
      get: (target, key, receiver) =>
        key === "canonicalPath"
          ? (name: string) => (name === "currentFocus" ? link : target.canonicalPath(name))
          : Reflect.get(target, key, receiver),
    });
    const aliased = { ...ctx, taxonomy } as BrainContext;
    try {
      const { result, opened } = await opensDuring([FOCUS], () =>
        assembleContext(db, aliased, { query: SCOPE_QUERY, maxTokens: 4000, now: NOW, scope: { exclude: [FOCUS] } })
      );
      expect(opened).toEqual([]);
      expect(result).not.toContain(FOCUS_MARKER);
      expect(result).not.toContain("## Current Focus");
      // The premise: unscoped, the link is read as the current focus.
      expect(await assembleContext(db, aliased, { query: SCOPE_QUERY, maxTokens: 4000, now: NOW })).toContain(FOCUS_MARKER);
    } finally {
      fs.rmSync(join(brain.root, link));
    }
  });

  test("an include entry that would leave the root, or is not a plain path, is refused before anything is read", async () => {
    for (const entry of ["../outside.md", "/etc/passwd", "projects/./x.md", "projects//x.md", "projects\\x.md", "c:x.md", "", "a\u0000b"]) {
      expect(scopeEntryError(entry), JSON.stringify(entry)).not.toBeNull();
      const { opened } = await opensDuring([FOCUS], async () => {
        await expect(assembleContext(db, ctx, { query: SCOPE_QUERY, scope: { include: [entry] } })).rejects.toThrow("include:");
      });
      expect(opened).toEqual([]);
    }
    expect(() => parseContextScope({ exclude: Array.from({ length: MAX_SCOPE_ENTRIES + 1 }, (_, i) => `notes/${i}.md`) })).toThrow(
      `the most it may hold is ${MAX_SCOPE_ENTRIES}`
    );
  });
});

describe("an include set constrains selection and expansion", () => {
  const PROJECTS = "projects/active/sail-repairs/";

  test("only included paths are placed, even with budget to spare, and the canonical slots it does not cover stay out", async () => {
    const { text, report, coverage } = await assemble({ maxTokens: 12000, scope: { include: [PROJECTS] } });
    expect(report.identity).toBeNull();
    expect(report.focus).toBeNull();
    expect(report.results.length).toBeGreaterThan(0);
    for (const path of [...report.results, ...report.related]) expect(path.startsWith(PROJECTS), path).toBe(true);
    for (const excerpt of coverage.excerpts) expect(excerpt.path.startsWith(PROJECTS), excerpt.path).toBe(true);
    // The budget is left unused rather than filled with unrelated documents.
    expect(estimateTokens(text)).toBeLessThan(6000);
    expect(text).not.toContain("## Identity");
    expect(text).not.toContain(FOCUS_MARKER);
  });

  test("an exclusion wins over an inclusion that covers it", async () => {
    const { result, opened } = await opensDuring([FOCUS], () => assemble({ scope: { include: ["context/"], exclude: [FOCUS] } }));
    expect(opened).toEqual([]);
    expect(result.report.focus).toBeNull();
    expect(result.coverage.excerpts.every((e) => e.path.startsWith("context/") && e.path !== FOCUS)).toBe(true);
  });

  test("an exact entry names one file, and a prefix needs its trailing slash", async () => {
    const exact = await assemble({ scope: { include: ["projects/active/sail-repairs/status.md"] } });
    expect(exact.coverage.excerpts.map((e) => e.path)).toEqual(["projects/active/sail-repairs/status.md"]);
    // Without the slash the entry is a file path, and no file is called that.
    const bare = await assemble({ scope: { include: ["projects/active/sail-repairs"] } });
    expect(bare.coverage.excerpts).toEqual([]);
    expect(bare.coverage.omitted).toEqual([{ path: "projects/active/sail-repairs", reason: "unavailable" }]);
  });
});

describe("coverage", () => {
  test("every excerpt keeps its source path and lane, in output order, and the briefing never claims to be exhaustive", async () => {
    const { text, coverage } = await assemble({ maxTokens: 12000, scope: { exclude: [REGISTRY] } });
    expect(coverage.exhaustive).toBe(false);
    expect(coverage.include).toBeNull();
    expect(coverage.exclude).toEqual([REGISTRY]);
    expect(coverage.excerpts[0]).toEqual({ path: "me/identity.md", lane: "identity", form: "whole" });
    expect(coverage.excerpts[1]).toEqual({ path: FOCUS, lane: "focus", form: "whole" });
    const search = coverage.excerpts.filter((e) => e.lane === "search");
    expect(search.length).toBeGreaterThan(0);
    let at = 0;
    for (const excerpt of search) {
      const found = text.indexOf(`(${excerpt.path})`, at);
      expect(found, excerpt.path).toBeGreaterThan(-1);
      at = found;
      expect(["snippet", "section", "cut"]).toContain(excerpt.form);
    }
    for (const excerpt of coverage.excerpts.filter((e) => e.lane === "related")) {
      expect(excerpt.form).toBe("summary");
      expect(text).toContain(`(${excerpt.path})`);
    }
    expect(coverageNote(coverage)).toContain("not an inventory of the scope");
  });

  test("omitted requested paths say why: unavailable, not ranked, excluded or budget", async () => {
    const include = ["projects/active/sail-repairs/status.md", "health/knee-injury.md", "notes/no-such-note.md", FOCUS];
    const { coverage } = await assemble({ includeCurrentFocus: false, scope: { include, exclude: [FOCUS] } });
    expect(coverage.excerpts.map((e) => e.path)).toEqual(["projects/active/sail-repairs/status.md"]);
    expect(coverage.omitted).toEqual([
      { path: "health/knee-injury.md", reason: "not_ranked" },
      { path: "notes/no-such-note.md", reason: "unavailable" },
      { path: FOCUS, reason: "excluded" },
    ]);
    const note = coverageNote(coverage);
    expect(note).toContain("health/knee-injury.md (not ranked)");
    expect(note).toContain("notes/no-such-note.md (unavailable)");
  });

  test("budget exhaustion is explicit", async () => {
    const { coverage } = await assemble({ maxTokens: 120, scope: { include: ["projects/", FOCUS] } });
    expect(coverage.budgetExhausted).toBe(true);
    expect(coverage.omitted.some((o) => o.reason === "budget")).toBe(true);
    expect(coverageNote(coverage)).toContain("Budget exhausted");
  });

  test("an unscoped call, or one with empty lists, is unchanged and leaves the coverage record untouched", async () => {
    for (const scope of [undefined, {}, { include: [], exclude: [] }]) {
      const coverage = emptyContextCoverage();
      const scoped = await assembleContext(db, ctx, { query: SCOPE_QUERY, maxTokens: 4000, now: NOW, scope, coverage });
      const plain = await assembleContext(db, ctx, { query: SCOPE_QUERY, maxTokens: 4000, now: NOW });
      expect(scoped).toBe(plain);
      expect(coverage).toEqual(emptyContextCoverage());
    }
  });
});

describe("budget guarantees hold under a scope", () => {
  test("a larger budget never drops a scoped hit, and no budget is exceeded", async () => {
    const scope = { include: ["projects/", "studies/", "health/"], exclude: [REGISTRY] };
    let previous: string[] = [];
    const dropped: string[] = [];
    const over: number[] = [];
    for (let budget = 200; budget <= 2400; budget += 20) {
      const report = emptyAssembleReport();
      const out = await assembleContext(db, ctx, { query: "raft spars knee navigation", maxTokens: budget, now: NOW, report, scope });
      for (const path of previous) if (!report.results.includes(path)) dropped.push(`${path} at ${budget}`);
      if (estimateTokens(out) > budget) over.push(budget);
      previous = report.results;
    }
    expect(previous.length).toBeGreaterThan(1);
    expect(dropped).toEqual([]);
    expect(over).toEqual([]);
  });
});

// #3644's evaluation: the status of each active project, gathered once as a
// scoped briefing over the known status files and once as targeted reads of
// the same files. The briefing must keep every required fact, say where each
// came from, and never present itself as an enumeration of the projects.
describe("evaluation: a scoped project-evidence task against targeted reads", () => {
  const STATUS = ["projects/active/raft/status.md", "projects/active/sail-repairs/status.md"];
  const EVIDENCE: Record<string, string[]> = {
    "projects/active/raft/status.md": ["construction has not started", "Get permission and the tools, then cut and join the timber"],
    "projects/active/sail-repairs/status.md": ["First batch of six practice spars spliced and sealed", "Second batch of blanks is next"],
  };

  test("every fact is in its own excerpt, or that excerpt is marked partial and the targeted read holds it", async () => {
    const reads = new Map(STATUS.map((path) => [path, readDocument(ctx.root, { path })]));
    // The premise: the targeted reads hold the required evidence.
    for (const path of STATUS) for (const fact of EVIDENCE[path]!) expect(reads.get(path)).toContain(fact);

    const { text, coverage } = await assemble({ query: "project status next action", maxTokens: 2000, scope: { include: STATUS, exclude: [FOCUS, REGISTRY] } });
    expect(coverage.excerpts.map((e) => e.path).sort()).toEqual([...STATUS].sort());
    expect(coverage.omitted).toEqual([]);
    expect(coverage.exhaustive).toBe(false);
    const missing: string[] = [];
    for (const excerpt of coverage.excerpts) {
      // Each fact must sit under the header that names its own source path.
      const at = text.indexOf(`(${excerpt.path})`);
      expect(at, excerpt.path).toBeGreaterThan(-1);
      const next = text.indexOf("\n### ", at + 1);
      const body = text.slice(at, next === -1 ? undefined : next);
      const lost = EVIDENCE[excerpt.path]!.filter((fact) => !body.includes(fact));
      // A fact the excerpt lacks is never lost silently: the excerpt says it is partial.
      if (lost.length > 0) expect({ path: excerpt.path, form: excerpt.form }).not.toEqual({ path: excerpt.path, form: "section" });
      missing.push(...lost.map((fact) => `${excerpt.path}: ${fact} (${excerpt.form})`));
    }
    // What this fixture measures today (#370's section expansion): the raft
    // status hit stays a snippet, so its next action needs the targeted read;
    // the sail-repairs status arrives as its whole section.
    expect(missing).toEqual(["projects/active/raft/status.md: Get permission and the tools, then cut and join the timber (snippet)"]);
    expect(coverageNote(coverage)).toContain("- Partial (read in full for the rest): projects/active/raft/status.md (snippet)");
    // Nothing outside the two files is offered, and the briefing costs less
    // than the two reads, which also carry frontmatter.
    expect(text).not.toContain("## Identity");
    expect(estimateTokens(text)).toBeLessThan(estimateTokens([...reads.values()].join("\n\n")));
  });

  test("a folder scope is ranked, not enumerated: the note says so, and the archived project is neither returned nor claimed", async () => {
    const { text, coverage } = await assemble({ query: "project status next action", maxTokens: 2000, scope: { include: ["projects/"], exclude: [REGISTRY] } });
    expect(coverage.exhaustive).toBe(false);
    expect(coverage.excerpts.some((e) => e.path === "projects/archive/one-old-build.md")).toBe(false);
    expect(coverage.omitted.some((o) => o.path === "projects/archive/one-old-build.md")).toBe(false);
    expect(text).not.toContain("one-old-build");
    expect(coverageNote(coverage)).toContain("not an inventory of the scope");
  });
});
