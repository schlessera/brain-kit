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
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { markdownAnchors, markdownLinks, splitLink } from "./markdown-anchors";

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
 *   often with a line range, and sometimes in another repository.
 *   Those records are append-only by rule — you supersede an entry, you do not
 *   rewrite one — so a gate that demanded they track the current tree would be
 *   demanding the one edit the records forbid.
 *
 * Their links are a different matter: a broken link between two records is a
 * plain defect, so the link test below covers every document.
 *
 * A decision record's `path:line` citations are checked by a different rule
 * in `tests/decision-citations.test.ts`: each names an anchor that its range
 * must start on, or is a listed exception. That test tracks the current tree
 * on purpose, because re-pointing a citation changes how the record points,
 * not what it says.
 */
const CITATION_EXEMPT_DIRS = new Set(["plans", "brainstorms", "decisions"]);

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

/** Links to another scheme are not files in this repo. */
const EXTERNAL = /^(https?:|mailto:|data:)/;

/** Each doc's links, parsed once: code spans and fences hold none. */
const linksOf = new Map(files.map((file) => [file, markdownLinks(readFileSync(join(ROOT, file), "utf8"))]));

const anchorCache = new Map<string, Set<string>>();
function anchorsOf(path: string): Set<string> {
  let anchors = anchorCache.get(path);
  if (!anchors) {
    anchors = markdownAnchors(readFileSync(path, "utf8"));
    anchorCache.set(path, anchors);
  }
  return anchors;
}

describe("documentation paths", () => {
  test("D44 is a parsed heading in the design record", () => {
    const body = readFileSync(join(ROOT, "docs/decisions/design-kit.md"), "utf8");
    expect(markdownAnchors(body).has(
      "2026-09-22--d44-the-bridge-tools-are-always-loaded-not-deferred-behind-tool-search",
    )).toBe(true);
  });

  test("D43's reproduction command ends before its explanatory prose", () => {
    const body = readFileSync(join(ROOT, "docs/decisions/design-kit.md"), "utf8");
    const { children } = unified().use(remarkParse).parse(body);
    const index = children.findIndex((node) => node.type === "code"
      && node.value.startsWith("bun scripts/measure-show-block.ts --always-load"));
    expect(index).toBeGreaterThanOrEqual(0);
    const command = children[index];
    expect(command?.type).toBe("code");
    if (command?.type !== "code") throw new Error("D43 reproduction command missing");
    expect(command.lang).toBe("sh");
    expect(command.value).toBe(String.raw`bun scripts/measure-show-block.ts --always-load --reps 3 --only \
  compare-short,compare-long,trend,contact,table,steps,quote,bars`);
    const prose = children[index + 1];
    expect(prose?.type).toBe("paragraph");
    expect(toString(prose).replace(/\s+/g, " ")).toBe(
      "It is a script and not a test: it needs the network and a key, so CI never runs it. Re-run it before changing the brief again.",
    );
  });

  test("there are docs to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("every relative markdown link resolves", () => {
    const broken: string[] = [];
    for (const [file, urls] of linksOf) {
      for (const url of urls) {
        if (EXTERNAL.test(url)) continue;
        const link = splitLink(url);
        if ("error" in link) {
          broken.push(`${file} -> ${link.error}`);
          continue;
        }
        if (link.path === "") continue;
        const resolved = normalize(join(ROOT, dirname(file), link.path));
        if (!existsSync(resolved)) broken.push(`${file} -> ${url}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every #fragment on a relative markdown link names a heading in its target", () => {
    // A renamed heading breaks every link into it and leaves the file part
    // resolving, so the test above stays green. Fragments into other file
    // kinds (`#L10` on source) and on external links are not checked. The
    // match is exact: every heading slug is lowercase, so `#Setup` is written
    // wrong even if a browser forgives it, and an explicit anchor keeps the
    // case it was written with.
    const broken: string[] = [];
    for (const [file, urls] of linksOf) {
      for (const url of urls) {
        if (EXTERNAL.test(url)) continue;
        const link = splitLink(url);
        if ("error" in link || !link.fragment) continue;
        const resolved = link.path === "" ? join(ROOT, file) : normalize(join(ROOT, dirname(file), link.path));
        if (!resolved.endsWith(".md") || !existsSync(resolved)) continue;
        if (!anchorsOf(resolved).has(link.fragment)) broken.push(`${file} -> ${url}`);
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
    // The app moved out of its original deployment shell into
    // packages/ui-server and packages/ui-react. Prose that still says `server/src/…` or `client/src/…`
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
