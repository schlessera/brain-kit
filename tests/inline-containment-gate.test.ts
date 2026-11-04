/**
 * The inline-containment gate (scripts/check-inline-containment.ts, #3423):
 * package source asks `isWithin` whether a path is a root or below it, rather
 * than spelling `path.startsWith(`${root}/`)` by hand.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { NOT_A_PATH, scanSource, scanTree } from "../scripts/check-inline-containment";

const ROOT = resolve(import.meta.dir, "..");
const FILE = "packages/ui-server/src/brain/example.ts";
const sites = (text: string, file = FILE) => scanSource(file, text).map((f) => f.text);

describe("the refused shapes", () => {
  test("a root followed by a separator, as a template or a concatenation", () => {
    for (const check of [
      "path.startsWith(`${root}/`)",
      "path.startsWith(`${options.brainPath}/`)",
      "path.startsWith(`${resolve(root)}/`)",
      "path.startsWith(`${root}${sep}`)",
      "path.startsWith(`${root}${path.sep}`)",
      'path.startsWith(root + "/")',
      "path.startsWith(root + '/')",
      "path.startsWith(root + sep)",
      "path.startsWith(root + path.sep)",
      'path.startsWith((root + "/") as string)',
      'path!.startsWith(held.path + "/")',
      'path.startsWith(a + b + "/")',
    ]) {
      expect({ check, sites: sites(`const inside = ${check};\n`) }).toEqual({ check, sites: [check] });
    }
  });

  test("literal prefixes, other separators and comments are not containment checks", () => {
    for (const text of [
      'rel.startsWith(".git/");',
      "rel.startsWith(`.git/`);",
      'rel.startsWith("../");',
      "rel.startsWith(`..${sep}`);",
      "rel.startsWith(`/${seg}/`);",
      "rel.startsWith(`${a}/${b}/`);",
      "rel.startsWith(`${root}:`);",
      'rel.startsWith(root + ":");',
      'rel.startsWith("/" + root);',
      "rel.startsWith(prefix);",
      "rel.endsWith(`${root}/`);",
      "// path.startsWith(`${root}/`)\nconst note = 'path.startsWith(root + \"/\")';",
    ]) {
      expect({ text, sites: sites(text) }).toEqual({ text, sites: [] });
    }
  });
});

describe("the tree", () => {
  test("package source on main checks containment through isWithin only", () => {
    expect(scanTree(ROOT)).toEqual({ findings: [], miscounted: [] });
  });

  test("every non-path entry names a reason", () => {
    for (const entry of NOT_A_PATH) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.count).toBeGreaterThan(0);
    }
  });

  test("finds package source sites, counts allowlisted files exactly and skips everything else", () => {
    const root = mkdtempSync(join(tmpdir(), "inline-containment-gate-"));
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    const dirty = "const hero = \"Odysseus\";\nexport const inside = (root: string, path: string) => path.startsWith(`${root}/`);\n";
    const allowed = NOT_A_PATH[0]!;
    try {
      write("packages/core/src/nested/a.ts", dirty);
      write("packages/ui-sdk/src/b.tsx", dirty);
      for (const file of ["packages/core/tests/a.test.ts", "packages/core/src/dist/a.ts",
        "packages/core/src/node_modules/a.ts", "scripts/a.ts", "tests/a.test.ts", "packages/core/src/a.md"]) write(file, dirty);
      for (const entry of NOT_A_PATH) write(entry.file, dirty.repeat(entry.count));
      expect(scanTree(root)).toEqual({
        findings: [
          { file: "packages/core/src/nested/a.ts", line: 2, column: 55, text: "path.startsWith(`${root}/`)" },
          { file: "packages/ui-sdk/src/b.tsx", line: 2, column: 55, text: "path.startsWith(`${root}/`)" },
        ],
        miscounted: [],
      });

      // One more site in an allowlisted file fails as a count change.
      write(allowed.file, dirty.repeat(allowed.count + 1));
      expect(scanTree(root).miscounted).toEqual([{ file: allowed.file, expected: allowed.count, actual: allowed.count + 1 }]);

      const child = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, "../scripts/check-inline-containment.ts"), root],
        stdout: "pipe", stderr: "pipe",
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain("packages/core/src/nested/a.ts:2:55: path.startsWith(`${root}/`)");

      write("packages/core/src/nested/a.ts", "export {};\n");
      write("packages/ui-sdk/src/b.tsx", "export {};\n");
      write(allowed.file, dirty.repeat(allowed.count));
      expect(scanTree(root)).toEqual({ findings: [], miscounted: [] });
      const clean = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, "../scripts/check-inline-containment.ts"), root],
        stdout: "pipe", stderr: "pipe",
      });
      expect(clean.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
