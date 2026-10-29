/**
 * The frontmatter-parse gate (scripts/check-frontmatter-parse.ts, #142):
 * gray-matter is loaded only by its designated files, and there only through
 * calls that always pass a literal options object.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
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
    // Focused designated-file proof; lint owns the repository-wide scan.
    for (const file of [HELPER, SERIALIZER]) {
      expect(scanSource(file, readFileSync(resolve(ROOT, file), "utf8"))).toEqual([]);
    }
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
  test("discovers violations across source roots and excludes generated and unrelated files", () => {
    const root = mkdtempSync(join(tmpdir(), "frontmatter-gate-"));
    const dirty = 'const heading = "Odysseus";\nimport matter from "gray-matter";\n';
    const files = [
      "packages/core/src/nested/a.ts", "packages/core/tests/a.tsx",
      "packages/core/scripts/a.js", "scripts/nested/a.mjs",
      "tests/nested/a.cjs", "experiments/nested/a.ts",
    ];
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    try {
      for (const file of files) write(file, dirty);
      write(HELPER, 'import matter from "gray-matter";\nmatter(input, {});\n');
      write("packages/core/src/clean.ts", 'export const hero = "Odysseus";');
      for (const file of ["packages/core/src/dist/a.ts", "tests/node_modules/a.ts",
        "docs/a.ts", "packages/core/src/a.md"]) write(file, dirty);
      const findings = scanTree(root);
      expect(findings.map(({ file, line, column, rule }) => ({ file, line, column, rule })))
        .toEqual([...files].sort().map(file => ({ file, line: 2, column: 1, rule: 1 })));
      for (const finding of findings) expect(finding.message).toContain("gray-matter loaded outside");
      const child = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, "../scripts/check-frontmatter-parse.ts"), root],
        stdout: "pipe", stderr: "pipe",
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain("packages/core/src/nested/a.ts:2:1: [rule 1]");
      for (const file of files) write(file, "export {};\n");
      expect(scanTree(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
