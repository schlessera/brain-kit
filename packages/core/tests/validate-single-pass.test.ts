/**
 * `validateDetailed` reads and parses each file once (#4785).
 *
 * Link and `supersedes` checks need every file's aliases before any file can
 * be judged, which used to mean a second read and a second frontmatter parse
 * of the whole corpus. These tests count the reads, check that an alias
 * declared late in scan order still resolves a link made early, and pin the
 * issues the edge cases produce.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";

import { brainConfigSchema, loadUserConfig } from "../src/lib/config";
import { getMarkdownFiles } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { validateDetailed } from "../src/lib/validate";
import { cleanup, makeTempBrain } from "./cli-harness";

const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: { types: { study: { dir: "studies" } } } }) });

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) cleanup(dir);
});

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function makeCorpus(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "brain-validate-pass-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function doc(fields: Record<string, string>, body = "body"): string {
  return ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", "", body, ""].join("\n");
}

/** Count reads of files under `root`, keyed by path relative to it. */
function countReads(root: string): Map<string, number> {
  const reads = new Map<string, number>();
  const real = fs.readFileSync;
  spies.push(
    spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string") {
        const rel = relative(root, resolve(path));
        if (!rel.startsWith("..")) reads.set(rel, (reads.get(rel) ?? 0) + 1);
      }
      return (real as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync)
  );
  return reads;
}

describe("validateDetailed reads each file once", () => {
  let corpus: string;
  let corpusTaxonomy: ReturnType<typeof buildTaxonomy>;
  beforeAll(async () => {
    corpus = makeTempBrain();
    dirs.push(corpus);
    corpusTaxonomy = buildTaxonomy({ user: (await loadUserConfig(corpus)).config });
  });

  test("every markdown file of the fixture corpus is read exactly once", () => {
    const files = getMarkdownFiles(corpus, corpusTaxonomy);
    expect(files.length).toBeGreaterThan(10);
    const reads = countReads(corpus);
    validateDetailed(corpus, corpusTaxonomy);
    expect(files.filter((file) => reads.get(file) !== 1).map((file) => [file, reads.get(file) ?? 0])).toEqual([]);
  });

  test("a link made early in scan order resolves through an alias declared late", () => {
    const root = makeCorpus({
      "notes/a-early.md": doc({ type: "note", title: "Early", tags: "[a]" }, "Sailing to [[The Wine-Dark Sea]]."),
      "notes/z-late.md": doc({ type: "note", title: "Late", tags: "[a]", aliases: '["The Wine-Dark Sea"]' }),
    });
    const files = getMarkdownFiles(root, taxonomy);
    expect(files.indexOf("notes/a-early.md")).toBeLessThan(files.indexOf("notes/z-late.md"));
    expect(validateDetailed(root, taxonomy).filter((issue) => issue.detail.rule === "link-unresolved")).toEqual([]);
  });

  test("a missing block, invalid YAML and a byte order mark give the issues they always gave", () => {
    const fields = { type: "note", title: "Ithaca", created: '"2026-07-12"', updated: '"2026-07-12"', tags: "[ithaca]" };
    const root = makeCorpus({
      "notes/bom.md": `\uFEFF${doc(fields)}`,
      "notes/bad-yaml.md": "---\ntitle: [unclosed\n---\n\nbody\n",
      "notes/four-dash.md": "----\ntitle: x\n----\nbody\n",
      "notes/raw.md": "no frontmatter here\n",
    });
    const issues = validateDetailed(root, taxonomy);
    expect(issues.filter((issue) => issue.file === "notes/bom.md")).toEqual([]);
    expect(issues.filter((issue) => issue.file === "notes/raw.md")).toEqual([
      { file: "notes/raw.md", level: "error", message: "Missing YAML frontmatter", detail: { rule: "frontmatter-missing" } },
    ]);
    expect(issues.filter((issue) => issue.file === "notes/four-dash.md")).toEqual([
      { file: "notes/four-dash.md", level: "error", message: "Missing YAML frontmatter", detail: { rule: "frontmatter-missing" } },
    ]);
    const invalid = issues.filter((issue) => issue.file === "notes/bad-yaml.md");
    expect(invalid).toHaveLength(1);
    expect(invalid[0].level).toBe("error");
    expect(invalid[0].detail).toEqual({ rule: "frontmatter-invalid" });
    expect(invalid[0].message).toStartWith("Invalid YAML frontmatter: ");
    expect(invalid[0].message.length).toBeGreaterThan("Invalid YAML frontmatter: ".length);
  });

  test("an alias that cannot be read as text stops only that file's collection", () => {
    const root = makeCorpus({
      "notes/odd.md": doc({ type: "note", title: "Odd", tags: "[a]", aliases: "[Scheria, {toString: Ithaca}]" }, "See [[Scheria]]."),
      "notes/ithaca.md": doc({ type: "note", title: "Ithaca", tags: "[a]" }, "See [[ithaca]]."),
    });
    const issues = validateDetailed(root, taxonomy);
    // The alias before the unreadable one still resolves, and both files are checked.
    expect(issues.filter((issue) => issue.detail.rule === "link-unresolved")).toEqual([]);
    expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
  });

  test("a file that cannot be read fails the call, as the check pass always made it", () => {
    const root = makeCorpus({
      "notes/ithaca.md": doc({ type: "note", title: "Ithaca", tags: "[a]" }),
      "notes/ogygia.md": doc({ type: "note", title: "Ogygia", tags: "[a]" }),
    });
    const real = fs.readFileSync;
    const gone = join(root, "notes/ogygia.md");
    spies.push(
      spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        if (typeof path === "string" && resolve(path) === gone) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${gone}'`), { code: "ENOENT" });
        }
        return (real as (...a: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync)
    );
    expect(() => validateDetailed(root, taxonomy)).toThrow("ENOENT");
  });
});
