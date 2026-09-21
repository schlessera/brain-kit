/**
 * Documentation path guard.
 *
 * Prose citing a file path is the only kind of documentation that can be
 * checked mechanically, and it is exactly the kind that rots silently: the
 * integration contract pointed at `server/src/brain/client.ts` for the whole
 * life of the extracted packages, because a path in a table is not a link and
 * nothing ever resolved it.
 *
 * Over repo-level documentation only (see DOC_FILES/DOC_ROOTS): relative links
 * resolve, code spans that LOOK like a repo path resolve, no span still cites
 * the pre-extraction `server/src/…` layout, and a span written as a directory
 * is one.
 *
 * The scope and the "looks like a repo path" test are narrow on purpose. Bare
 * filenames (`SKILL.md`), package-relative spans (`src/lib/seams.ts`) and
 * content-repo paths (`me/identity.md`) are addressed to a reader, not to the
 * filesystem; demanding they resolve would produce noise this gate could not
 * survive, and a gate that cries wolf gets deleted.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, normalize, relative, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

/** Top-level directories a documented path may be rooted at. */
const REPO_DIRS = [
  "packages",
  "docs",
  "scripts",
  "tests",
  ".github",
  ".agents",
  "api-report",
];

/**
 * Repo-level documentation only: the files that describe THIS repo's layout to
 * a reader, and whose paths are therefore rooted at the repo.
 *
 * Everything else is deliberately out of scope. A package README says
 * `tests/runtime.test.ts` meaning its own tests directory; `template/` is the
 * source of a different repo entirely; CHANGELOG.md is changesets boilerplate;
 * and a plan under `.agents/plans/` quotes the paths a finding was about, which
 * are stale by the time the plan is done — that is the point of a plan.
 */
const DOC_ROOTS = ["docs"];
const DOC_FILES = [
  "README.md",
  "ROADMAP.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
];

/**
 * Directories whose PATH CITATIONS are exempt — their links are still checked.
 *
 * Two kinds of document cite a path that is not meant to resolve today:
 *
 * - A **plan** names files it intends to create and quotes paths from other
 *   repos. Demanding those resolve would fail every plan before its first
 *   implementation commit.
 * - A **decision record** cites the code as it was when the decision was made,
 *   often with a line range, and often in the private deployment-shell repo.
 *   Those records are append-only by rule — you supersede an entry, you do not
 *   rewrite one — so a gate that demanded they track the current tree would be
 *   demanding the one edit the records forbid.
 *
 * Their links are a different matter: a broken link between two records is a
 * plain defect, so the link test below covers every document.
 */
const CITATION_EXEMPT_DIRS = new Set(["plans", "brainstorms", "decisions"]);

/**
 * Inline code spans and fenced blocks, blanked out.
 *
 * Without this the link test reads Overpass QL — `way["natural"="coastline"](bbox)`
 * — as a markdown link to a file called `bbox`. Any bracket-then-paren syntax
 * inside a code span does the same.
 */
function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** `path.ts:12` and `path.ts:12-40` are citations of a path, not of a file. */
function withoutLineSuffix(target: string): string {
  return target.replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, "");
}

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      markdownFiles(path, found);
    } else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

const files = [
  ...DOC_FILES.filter((f) => existsSync(join(ROOT, f))),
  ...DOC_ROOTS.flatMap((d) => markdownFiles(join(ROOT, d)).map((f) => relative(ROOT, f))),
];

/** The subset whose path citations are expected to describe the tree today. */
const citationFiles = files.filter(
  (file) => !file.split("/").some((segment) => CITATION_EXEMPT_DIRS.has(segment)),
);

describe("documentation paths", () => {
  test("there are docs to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("every relative markdown link resolves", () => {
    const broken: string[] = [];
    for (const file of files) {
      const body = withoutCode(readFileSync(join(ROOT, file), "utf8"));
      for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|data:|#)/.test(target)) continue;
        const resolved = normalize(join(ROOT, dirname(file), target));
        if (!existsSync(resolved)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every code span that names a repo path resolves", () => {
    // A span with a glob or a placeholder is describing a shape, not naming a
    // file: `packages/*/src/**`, `packages/core/src/lib/module-*.ts`.
    const pattern = new RegExp(
      "`((?:" + REPO_DIRS.map((d) => d.replace(".", "\\.")).join("|") + ")/[^`\\s]+)`",
      "g"
    );
    const broken: string[] = [];
    for (const file of citationFiles) {
      const body = readFileSync(join(ROOT, file), "utf8");
      for (const match of body.matchAll(pattern)) {
        const target = withoutLineSuffix(match[1].replace(/[.,;:]+$/, ""));
        if (target.includes("*") || target.includes("<") || target.includes("…")) continue;
        const resolved = join(ROOT, target);
        if (!existsSync(resolved)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("no doc cites a pre-extraction path", () => {
    // The app moved out of the brain-ui repo into packages/ui-server and
    // packages/ui-react. Prose that still says `server/src/…` or `client/src/…`
    // is describing a layout that has not existed since phase 4.
    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(join(ROOT, file), "utf8");
      for (const match of body.matchAll(/`((?:server|client|shared)\/src\/[^`\s]+)`/g)) {
        offenders.push(`${file} -> ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a documented directory is a directory and a documented file is a file", () => {
    const wrongKind: string[] = [];
    for (const file of citationFiles) {
      const body = readFileSync(join(ROOT, file), "utf8");
      for (const match of body.matchAll(/`([^`\s]+\/)`/g)) {
        const target = match[1];
        if (!REPO_DIRS.some((d) => target.startsWith(`${d}/`))) continue;
        if (target.includes("*")) continue;
        const resolved = join(ROOT, target);
        if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
          wrongKind.push(`${file} -> ${target} is not a directory`);
        }
      }
    }
    expect(wrongKind).toEqual([]);
  });
});
