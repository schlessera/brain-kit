/** Temporary-tree fixtures prove the gate; lint scans the real tree. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALLOWLIST, checkImportCycles, type CycleAllowlistEntry } from "../scripts/check-import-cycles.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: Record<string, string>, allowlist: CycleAllowlistEntry[] = []) {
  const root = mkdtempSync(join(tmpdir(), "import-cycles-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return checkImportCycles(root, { allowlist, files: Object.keys(files) });
}

const P = "packages/odysseus/src";

describe("import cycles gate", () => {
  test("a two-file cycle is one component naming both files", () => {
    const report = tree({
      [`${P}/ship.ts`]: 'import { crew } from "./crew.js";\nexport const ship = () => crew;\n',
      [`${P}/crew.ts`]: 'import { ship } from "./ship.js";\nexport const crew = () => ship;\n',
      [`${P}/oar.ts`]: 'import { ship } from "./ship.js";\nexport const oar = ship;\n',
    });
    expect(report.findings).toEqual([[`${P}/crew.ts`, `${P}/ship.ts`]]);
    expect(report.scannedFiles).toBe(3);
  });

  test("A↔B and B↔C are one component of three files, which back-edge-only search would split", () => {
    const report = tree({
      [`${P}/a.ts`]: 'import "./b.ts";\nexport const a = 1;\n',
      [`${P}/b.ts`]: 'import { a } from "./a.ts";\nimport { c } from "./c.ts";\nexport const b = () => a + c;\n',
      [`${P}/c.ts`]: 'export { b } from "./b.ts";\nexport const c = 1;\n',
    });
    expect(report.findings).toEqual([[`${P}/a.ts`, `${P}/b.ts`, `${P}/c.ts`]]);
  });

  test("a loop closed only by a type import or a dynamic import is not a cycle", () => {
    const closer = (line: string) => tree({
      [`${P}/a.ts`]: 'import { b } from "./b.ts";\nexport const a = () => b;\nexport type A = 1;\n',
      [`${P}/b.ts`]: `${line}\nexport const b = 1;\n`,
    }).findings;
    expect(closer('import type { A } from "./a.ts";')).toEqual([]);
    expect(closer('import { type A, type a } from "./a.ts";')).toEqual([]);
    expect(closer('export type { A } from "./a.ts";')).toEqual([]);
    expect(closer('export { type A } from "./a.ts";')).toEqual([]);
    expect(closer('export const later = () => import("./a.ts");')).toEqual([]);
    // Control: the same loop closed by a value import is a cycle.
    expect(closer('import { type A, a } from "./a.ts";')).toEqual([[`${P}/a.ts`, `${P}/b.ts`]]);
  });

  test("an allowlisted component passes; an entry with no component, or a subset of one, fails", () => {
    const files = {
      [`${P}/a.ts`]: 'import "./b.ts";\n',
      [`${P}/b.ts`]: 'import "./c.ts";\n',
      [`${P}/c.ts`]: 'import "./a.ts";\n',
    };
    const exact = { files: [`${P}/c.ts`, `${P}/a.ts`, `${P}/b.ts`], reason: "fixture" };
    const passing = tree(files, [exact]);
    expect(passing.findings).toEqual([]);
    expect(passing.allowlisted).toEqual([exact]);
    expect(passing.staleAllowlist).toEqual([]);

    const subset = { files: [`${P}/a.ts`, `${P}/b.ts`], reason: "fixture" };
    const gone = { files: [`${P}/x.ts`, `${P}/y.ts`], reason: "fixture" };
    const failing = tree(files, [subset, gone]);
    expect(failing.findings).toEqual([[`${P}/a.ts`, `${P}/b.ts`, `${P}/c.ts`]]);
    expect(failing.staleAllowlist).toEqual([subset, gone]);
  });

  test("tests, stories, other packages and files outside src are not scanned", () => {
    const report = tree({
      [`${P}/a.ts`]: 'import "./a.test.ts";\nexport const a = 1;\n',
      [`${P}/a.test.ts`]: 'import "./a.ts";\n',
      "packages/odysseus/tests/x.ts": 'import "./y.ts";\n',
      "packages/odysseus/tests/y.ts": 'import "./x.ts";\n',
      [`${P}/cross.ts`]: 'import "../../penelope/src/loom.ts";\n',
      "packages/penelope/src/loom.ts": 'import "../../odysseus/src/cross.ts";\n',
    });
    expect(report.findings).toEqual([]);
    expect(report.scannedFiles).toBe(3);
  });

  test("a scan that matches no file reports zero scanned files, which the command refuses", () => {
    expect(tree({ "scripts/a.ts": 'import "./b.ts";\n', "scripts/b.ts": 'import "./a.ts";\n' }).scannedFiles).toBe(0);
    const empty = mkdtempSync(join(tmpdir(), "import-cycles-empty-"));
    roots.push(empty);
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: empty }).exitCode).toBe(0);
    const run = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/check-import-cycles.ts"), empty], { stderr: "pipe", stdout: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("checked nothing");
  });

  test("every allowlist entry has two or more files and a reason that names a task or says it is permanent", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.files.length).toBeGreaterThan(1);
      expect(entry.reason).toMatch(/^permanent: |#\d+/);
    }
  });
});
