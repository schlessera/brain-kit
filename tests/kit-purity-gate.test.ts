/**
 * The ui-kit purity gate's own teeth.
 *
 * A lint gate that has never been seen to fail is indistinguishable from one
 * that is misconfigured, and this one guards a rule with no other enforcement:
 * a kit component that reaches for a store compiles, renders, and passes every
 * other check in the repo. So each rule gets a fixture that must trip it, and
 * the real kit sources must trip none.
 *
 * Fixtures are strings rather than files on disk: the scanner takes source
 * text, and a file full of deliberate violations sitting in packages/ would be
 * a violation.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { scanKit, scanSource } from "../scripts/check-kit-purity.ts";

const ROOT = resolve(import.meta.dir, "..");

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

  test("the real kit sources are clean", () => {
    expect(scanKit(ROOT)).toEqual([]);
  });
});
