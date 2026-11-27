/**
 * `validateDetailed` reads and parses each file once (#4785): link checks
 * still see every file's aliases, the per-file issues are the ones the two
 * passes reported, and a string kept between files is a copy, not a cut of a
 * file's text.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { estimateShallowMemoryUsageOf } from "bun:jsc";
import * as fs from "fs";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import { tempDirs } from "../../../tests/helpers/temp";
import { brainConfigSchema } from "../src/lib/config";
import { getMarkdownFiles } from "../src/lib/indexer/scan";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { validateDetailed } from "../src/lib/validate";

const CORPUS = resolve(import.meta.dir, "../fixtures/corpus");
const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: { types: { study: { dir: "studies" } } } }) });
const tempDir = tempDirs();

function corpus(files: Record<string, string>): string {
  const root = tempDir("odysseus-validate-pass-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const note = (title: string, extra: string[] = [], body = "body") =>
  ["---", `title: ${title}`, "type: study", 'created: "2026-07-12"', 'updated: "2026-07-12"', "tags: [voyage]", ...extra, "---", "", body, ""].join("\n");

/** Run `validateDetailed` with every `readFileSync` of a markdown file under `root` passed to `onRead` first. */
function withReads<T>(root: string, onRead: (path: string) => void, run: () => T): T {
  const readFileSync = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith(".md") && resolve(path).startsWith(`${root}/`)) onRead(resolve(path));
    return (readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

describe("one read and one parse per file (#4785)", () => {
  test("each markdown file of the fixture corpus is read exactly once", () => {
    const files = getMarkdownFiles(CORPUS, taxonomy).map((path) => resolve(CORPUS, path));
    expect(files.length).toBeGreaterThan(10);
    const reads = new Map<string, number>();
    withReads(CORPUS, (path) => reads.set(path, (reads.get(path) ?? 0) + 1), () => validateDetailed(CORPUS, taxonomy));
    expect(Object.fromEntries(files.map((path) => [path, reads.get(path) ?? 0])), "READ_ONCE_PER_FILE")
      .toEqual(Object.fromEntries(files.map((path) => [path, 1])));
  });

  test("a link early in scan order resolves through an alias declared late in it", () => {
    const root = corpus({
      "studies/a-departure.md": note("Departure", [], "The voyage ends at [[the great loom]]."),
      "studies/z-loom.md": note("Penelope's loom", ["aliases: [The Great Loom]"]),
    });
    expect(getMarkdownFiles(root, taxonomy)).toEqual(["studies/a-departure.md", "studies/z-loom.md"]);
    expect(validateDetailed(root, taxonomy), "LATE_ALIAS_RESOLVES_EARLY_LINK").toEqual([]);
  });

  test("a file with no frontmatter, invalid YAML, or a byte order mark before its fences each gives its issue", () => {
    const root = corpus({
      "studies/bom.md": `\uFEFF${note("Byte order mark")}`,
      "studies/broken.md": "---\ntitle: [unclosed\n---\n\nbody\n",
      "studies/raw.md": "no frontmatter here\n",
    });
    const issues = validateDetailed(root, taxonomy);
    expect(issues.filter((issue) => issue.file === "studies/bom.md"), "BOM_BEFORE_FENCES_IS_FRONTMATTER").toEqual([]);
    expect(issues.filter((issue) => issue.file === "studies/raw.md"), "NO_FRONTMATTER").toEqual([
      { file: "studies/raw.md", level: "error", message: "Missing YAML frontmatter", detail: { rule: "frontmatter-missing" } },
    ]);
    const broken = issues.filter((issue) => issue.file === "studies/broken.md");
    expect(broken.map(({ level, detail }) => ({ level, detail })), "INVALID_YAML").toEqual([{ level: "error", detail: { rule: "frontmatter-invalid" } }]);
    expect(broken[0]!.message).toStartWith("Invalid YAML frontmatter: ");
  });

  test("a file that cannot be read stops the run with its error", () => {
    const root = corpus({ "studies/a.md": note("Ithaca"), "studies/b.md": note("Pylos") });
    const gone = resolve(root, "studies/b.md");
    expect(() => withReads(root, (path) => {
      if (path === gone) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${gone}'`), { code: "ENOENT" });
    }, () => validateDetailed(root, taxonomy)), "UNREADABLE_FILE_THROWS").toThrow("ENOENT");
  });

  test("a link target kept for alias resolution is its own string, not a cut of its file's text", () => {
    // JavaScriptCore can keep a cut of a string as a view of the whole text's
    // buffer: a target kept that way would hold its file's body until the run
    // ends, and its estimated memory is then that buffer's, not its own.
    const target = "the long voyage no alias names";
    const root = corpus({ "studies/ithaca.md": note("Ithaca", [], `${"Odysseus sails on. ".repeat(20_000)}\nSee [[${target}]].`) });
    const [issue] = validateDetailed(root, taxonomy);
    expect(issue?.detail, "UNRESOLVED_TARGET_REPORTED").toEqual({ rule: "link-unresolved", target });
    expect(estimateShallowMemoryUsageOf((issue!.detail as { target: string }).target), "KEPT_TARGET_IS_A_COPY").toBeLessThan(1024);
  });
});
