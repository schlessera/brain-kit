/** Temporary-tree fixtures prove the gate; lint scans the real tree. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALLOWLIST, SCANNED_PACKAGES, check, type CheckOptions } from "../scripts/check-unused-exports.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const MANIFESTS: Record<string, string> = {
  "packages/ui-server/package.json": JSON.stringify({
    name: "@schlessera/brain-ui-server",
    exports: { ".": { bun: "./src/index.ts" }, "./internal": { bun: "./src/internal.ts" } },
  }),
  "packages/ui-kit/package.json": JSON.stringify({ name: "@schlessera/brain-ui-kit", exports: { ".": { bun: "./src/index.ts" } } }),
  "packages/core/package.json": JSON.stringify({ name: "@schlessera/brain", exports: { ".": { bun: "./src/index.ts" } } }),
  "packages/ui-server/src/index.ts": "",
  "packages/ui-server/src/internal.ts": "",
  "packages/ui-kit/src/index.ts": "",
  "packages/core/src/index.ts": "",
};

function tree(files: Record<string, string>, options: Omit<CheckOptions, "files"> = {}) {
  const root = mkdtempSync(join(tmpdir(), "unused-exports-"));
  roots.push(root);
  const all = { ...MANIFESTS, ...files };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return check(root, { allowlist: [], ...options, files: Object.keys(all) });
}

const names = (report: ReturnType<typeof check>) => report.findings.map(f => `${f.file}:${f.line} ${f.name}`);

describe("unused exports gate", () => {
  test("scans exactly ui-server, ui-kit and ui-react", () => {
    expect([...SCANNED_PACKAGES]).toEqual(["ui-server", "ui-kit", "ui-react"]);
  });

  test("an export no other file imports fails with its file, line and name", () => {
    const report = tree({ "packages/ui-server/src/probe.ts": "const x = 1;\nexport function unusedProbe() {}\n" });
    expect(report.findings).toEqual([{ file: "packages/ui-server/src/probe.ts", line: 2, name: "unusedProbe", kind: "declaration" }]);
  });

  test("a use in the declaring file alone does not count", () => {
    expect(names(tree({ "packages/ui-server/src/a.ts": "export const A = 1;\nexport const B = A + 1;\n" })))
      .toEqual(["packages/ui-server/src/a.ts:1 A", "packages/ui-server/src/a.ts:2 B"]);
  });

  test("an import from another file, in or outside the package, is a use", () => {
    expect(tree({
      "packages/ui-server/src/a.ts": "export const A = 1;\nexport type T = string;\nexport function f() {}\n",
      "packages/ui-server/src/b.ts": 'import { A, type T } from "./a.js";\nexport { };\nconsole.log(A as unknown as T);\n',
      "packages/ui-server/tests/a.test.ts": 'import { f } from "../src/a.ts";\nf();\n',
    }).findings).toEqual([]);
  });

  test("a re-export chain counts only when its end is imported", () => {
    const report = tree({
      "packages/ui-kit/src/a.ts": "export const A = 1;\nexport const B = 2;\n",
      "packages/ui-kit/src/barrel.ts": 'export { A, B as Renamed } from "./a.js";\n',
      "packages/ui-kit/src/use.ts": 'import { Renamed } from "./barrel.js";\nconsole.log(Renamed);\n',
    });
    expect(names(report)).toEqual(["packages/ui-kit/src/a.ts:1 A", "packages/ui-kit/src/barrel.ts:1 A"]);
    expect(report.findings.map(f => f.kind)).toEqual(["declaration", "re-export"]);
  });

  test("an entry point's own exports are not reported, and what it re-exports is used", () => {
    expect(tree({
      "packages/ui-server/src/index.ts": 'export const ENTRY = 1;\nexport { A } from "./a.js";\nexport * from "./b.js";\n',
      "packages/ui-server/src/a.ts": "export const A = 1;\n",
      "packages/ui-server/src/b.ts": "export const B = 1;\nexport type C = number;\n",
    }).findings).toEqual([]);
  });

  test("a package-specifier import resolves through the exports map", () => {
    expect(tree({
      "packages/ui-server/src/internal.ts": 'export { A } from "./a.js";\n',
      "packages/ui-server/src/a.ts": "export const A = 1;\n",
      "packages/ui-kit/src/x.ts": 'import { A } from "@schlessera/brain-ui-server/internal";\nconsole.log(A);\n',
    }).findings).toEqual([]);
  });

  test("namespace, dynamic, require, import-type and load-by-path uses mark the file used", () => {
    const declare = (n: number) => ({ [`packages/ui-server/src/m${n}.ts`]: "export const X = 1;\nexport type Y = 1;\n" });
    expect(tree({
      ...declare(1), ...declare(2), ...declare(3), ...declare(4), ...declare(5), ...declare(6), ...declare(7),
      "packages/ui-server/src/use.ts": [
        'import * as m1 from "./m1.js";',
        'const m2 = await import("./m2.js");',
        'const m3 = require("./m3.js");',
        'type T = import("./m4.js").Y | import("./m4.js").X;',
        "const m5 = new URL(`./m5${import.meta.url.endsWith(\".ts\") ? \".ts\" : \".js\"}`, import.meta.url);",
        'const m6 = Bun.resolveSync("./m6", import.meta.dir);',
        'const m7 = import.meta.resolve("./m7.js");',
        "console.log(m1, m2, m3, m5, m6, m7);",
      ].join("\n"),
    }).findings).toEqual([]);
  });

  test("a module publishing its own import.meta.url keeps every export", () => {
    expect(names(tree({
      "packages/ui-server/src/writes.ts": "export const url = import.meta.url;\nexport function setup() {}\n",
      "packages/ui-server/src/plain.ts": "export const here = new URL(\".\", import.meta.url);\n",
    }))).toEqual(["packages/ui-server/src/plain.ts:1 here"]);
  });

  test("a declaration the api-report signatures section records is not reported", () => {
    const report = tree({
      "packages/ui-server/src/a.ts": "export interface Reached { a: number }\nexport interface Unreached { b: number }\n",
      "api-report/ui-server.txt": [
        'export "." (./src/index.ts)',
        "  type Root",
        "",
        "signatures (every public export and the types it is made of)",
        "  Reached (packages/ui-server/src/a.ts)",
        "    export interface Reached {",
        "        a: number;",
        "    }",
        "",
      ].join("\n"),
    });
    expect(names(report)).toEqual(["packages/ui-server/src/a.ts:2 Unreached"]);
  });

  test("test, spec and story files under src are not scanned", () => {
    expect(tree({
      "packages/ui-kit/src/a.test.ts": "export const fixture = 1;\n",
      "packages/ui-kit/src/A.stories.tsx": "export const Default = {};\n",
      "packages/ui-kit/src/__tests__/helper.ts": "export const helper = 1;\n",
    }).findings).toEqual([]);
  });

  test("a package outside the scanned list is not reported", () => {
    expect(tree({ "packages/core/src/probe.ts": "export function unusedProbe() {}\n" }).findings).toEqual([]);
  });

  test("an allowlist entry excuses its export, and a stale one fails", () => {
    const allowlist = [
      { file: "packages/ui-server/src/a.ts", name: "A", reason: "inferred into an emitted declaration" },
      { file: "packages/ui-server/src/a.ts", name: "Gone", reason: "no longer exported" },
    ];
    const report = tree({ "packages/ui-server/src/a.ts": "export const A = 1;\n" }, { allowlist });
    expect(report.findings).toEqual([]);
    expect(report.allowlisted).toEqual([allowlist[0]!]);
    expect(report.staleAllowlist).toEqual([allowlist[1]!]);
  });

  test("every allowlist entry carries a reason and names a scanned package", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(SCANNED_PACKAGES.some(pkg => entry.file.startsWith(`packages/${pkg}/src/`))).toBe(true);
    }
  });
});
