/**
 * The frontmatter-parse gate (scripts/check-frontmatter-parse.ts, #142):
 * gray-matter is loaded only by its designated files, and there only through
 * calls that always pass a literal options object.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { scanSource, scanTree } from "../scripts/check-frontmatter-parse";

const ROOT = resolve(import.meta.dir, "..");
const OTHER = "packages/core/src/lib/indexer/parse.ts";
const HELPER = "packages/common/src/frontmatter-parse.ts";
const SERIALIZER = "packages/core/src/lib/frontmatter.ts";

const rules = (file: string, text: string) => scanSource(file, text).map((f) => f.rule);

describe("rule 1: gray-matter is loaded only by its designated files", () => {
  test("every loading form is refused elsewhere, in source, tests and scripts", () => {
    for (const load of [
      'import matter from "gray-matter";',
      'import parse from "gray-matter";',
      'import * as gm from "gray-matter";',
      'import { stringify } from "gray-matter";',
      'import type { GrayMatterFile } from "gray-matter";',
      'export { default } from "gray-matter";',
      'export { default as parseMatter } from "gray-matter";',
      'export * from "gray-matter";',
      'import gm = require("gray-matter");',
      'const gm = require("gray-matter");',
      'const gm = await import("gray-matter");',
      'import engines from "gray-matter/lib/engines";',
      'type File = import("gray-matter").GrayMatterFile<string>;',
    ]) {
      for (const file of [OTHER, "packages/core/tests/x.test.ts", "scripts/x.ts", "tests/x.test.ts", "packages/x/src/a.js"]) {
        expect({ load, file, rules: rules(file, load) }).toEqual({ load, file, rules: [1] });
      }
    }
  });

  test("the helper itself is not a loophole when it moves", () => {
    // Its former per-package paths, and the same file name in any other package.
    for (const file of [
      "packages/core/src/lib/frontmatter-parse.ts",
      "packages/module-jobs/src/lib/frontmatter-parse.ts",
      "packages/core/src/frontmatter-parse.ts",
      "packages/common/src/lib/frontmatter-parse.ts",
      "packages/common/tests/other.test.ts",
    ]) {
      expect({ file, rules: rules(file, 'import matter from "gray-matter";') }).toEqual({ file, rules: [1] });
    }
  });

  test("mentions in comments and strings, and the helper import, pass", () => {
    const text = '// gray-matter caches\nconst s = "gray-matter";\n' +
      'import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";\nparseFrontmatter(raw);\n';
    expect(scanSource(OTHER, text)).toEqual([]);
  });
});

describe("rule 2: inside a designated file, only literal-options calls", () => {
  const imported = 'import matter from "gray-matter";\n';

  test("the shipped helper and serializer pass", () => {
    expect(scanTree(ROOT).filter((f) => f.file === HELPER || f.file === SERIALIZER)).toEqual([]);
  });

  test("calls that pass a literal options object pass, as do type positions", () => {
    for (const use of [
      "matter(input, { ...options });",
      "matter(input, {});",
      "matter.stringify(c, d, { flowLevel: 1 } as any);",
      "type O = matter.GrayMatterOption<string, never>;",
      "interface O extends matter.GrayMatterOption<string, O> {}",
      "type F = ReturnType<typeof matter>;",
    ]) {
      expect({ use, findings: scanSource(HELPER, imported + use) }).toEqual({ use, findings: [] });
    }
  });

  test("a call without a literal options object, or any other use of the binding, is refused", () => {
    for (const use of [
      "matter(input);",
      "matter(input, options);",
      "matter(input, undefined);",
      "matter.stringify(c, d);",
      "matter.stringify(c, d, opts);",
      "matter.read(path, {});",
      "matter.test(s);",
      "matter.cache = {};",
      "const alias = matter;",
      "export default matter;",
      "export { matter };",
      "run(matter);",
      "const { stringify } = matter;",
      'matter["stringify"](c, d, {});',
    ]) {
      expect({ use, rules: rules(HELPER, imported + use) }).toEqual({ use, rules: [2] });
    }
  });

  test("an aliased default import is followed", () => {
    expect(rules(HELPER, 'import gm from "gray-matter";\ngm(input);')).toEqual([2]);
    expect(rules(HELPER, 'import * as gm from "gray-matter";\ngm.default(input);')).toEqual([2]);
  });

  test("a named import or a require is refused even in a designated file", () => {
    expect(rules(SERIALIZER, 'import { stringify } from "gray-matter";')).toEqual([2]);
    expect(rules(SERIALIZER, 'const gm = require("gray-matter");')).toEqual([2]);
  });
});

describe("the tree", () => {
  test("is clean", () => {
    expect(scanTree(ROOT)).toEqual([]);
  });
});
