/**
 * The ui-kit purity gate's own teeth.
 *
 * A lint gate that has never been seen to fail is indistinguishable from one
 * that is misconfigured, and this one guards a rule with no other enforcement:
 * a kit component that reaches for a store compiles, renders, and passes every
 * other check in the repo. So each rule gets a fixture that must trip it, and
 * bounded filesystem fixtures prove source discovery. Lint owns the real kit.
 *
 * Deliberate violations stay in strings or temporary trees outside the repo.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { scanKit, scanSource } from "../scripts/check-kit-purity.ts";

const VIOLATIONS: [string, number, string][] = [
  ["zustand import", 1, `import { create } from "zustand";\nexport const s = create(() => ({}));\n`],
  ["zustand subpath", 1, `import { persist } from "zustand/middleware";\nexport const p = persist;\n`],
  ["dynamic zustand import", 1, `export const s = await import("zustand");\n`],
  ["fetch call", 2, `export async function load() {\n  return fetch("/api/x");\n}\n`],
  ["window.fetch", 2, `export async function load() {\n  return window.fetch("/api/x");\n}\n`],
  ["uiConfig", 3, `import { uiConfig } from "./config.js";\nexport const base = uiConfig.apiBase;\n`],
  ["localStorage", 4, `export const seen = localStorage.getItem("seen");\n`],
  ["sessionStorage", 5, `export const seen = window.sessionStorage.getItem("seen");\n`],
  ["window.location", 6, `export function go() {\n  window.location.href = "/x";\n}\n`],
];

describe("ui-kit purity gate", () => {
  for (const [name, rule, source] of VIOLATIONS) {
    test(`${name} trips rule ${rule}`, () => {
      const findings = scanSource("packages/ui-kit/src/fixture.ts", source);
      expect(findings.map((f) => f.rule)).toContain(rule);
    });
  }

  test("a prop-driven component trips nothing", () => {
    // The shapes most likely to produce a false positive: a prop NAMED after a
    // banned global, and a local of the same name. Neither is ambient access.
    const source = `
      export interface Props { onNavigate: (to: string) => void; fetch?: never }
      export function C({ onNavigate }: Props) {
        const location = "here";
        return { location, go: () => onNavigate("/x") };
      }
    `;
    expect(scanSource("packages/ui-kit/src/c.ts", source)).toEqual([]);
  });

  test("discovers nested kit TS and TSX violations while excluding other sources", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-purity-gate-"));
    const files = ["packages/ui-kit/src/nested/a.ts", "packages/ui-kit/src/nested/b.tsx"];
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    try {
      for (const file of files) write(file, '\nfetch("/api/x");\n');
      write("packages/ui-kit/src/clean.tsx", "export const C = () => <div />;");
      for (const file of ["packages/ui-react/src/a.ts", "packages/ui-kit/tests/a.ts",
        "packages/ui-kit/src/a.js"]) write(file, 'fetch("/api/x");');
      const findings = scanKit(root);
      expect(findings.map(({ file, line, column, rule, symbol }) => ({ file, line, column, rule, symbol })))
        .toEqual(files.map(file => ({ file, line: 2, column: 1, rule: 2, symbol: "fetch" })));
      for (const finding of findings) expect(finding.message).toContain("prop");
      const child = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, "../scripts/check-kit-purity.ts"), root],
        stdout: "pipe", stderr: "pipe",
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain("packages/ui-kit/src/nested/a.ts:2:1: [rule 2] fetch");
      for (const file of files) write(file, "export {};\n");
      expect(scanKit(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
