import { expect, test } from "bun:test";
import { ICONS, checkIconImports } from "../scripts/check-icon-imports.js";

const page = "packages/ui-react/src/components/graph/graph-page.tsx";
const lib = "packages/ui-react/src/lib/trackers.ts";
const icons = 'export { Search, X } from "lucide-react";\nexport type { LucideIcon } from "lucide-react";\n';
const users = { [page]: 'import { Search, X } from "../icons.js";\nimport type { LucideIcon } from "../icons.js";\n' };

test("the real shape passes: named re-exports, each imported elsewhere", () => {
  expect(checkIconImports({ [ICONS]: icons, ...users })).toEqual([]);
});

test("every import form of lucide-react outside icons.ts is one finding naming the file and line", () => {
  for (const line of [
    'import { X } from "lucide-react";',
    'import type { LucideIcon } from "lucide-react";',
    'export { X } from "lucide-react";',
    'export * from "lucide-react";',
    'const glyphs = await import("lucide-react");',
    'type Glyphs = typeof import("lucide-react");',
    'import "lucide-react";',
  ]) {
    for (const file of [page, lib]) {
      expect(checkIconImports({ [ICONS]: icons, ...users, [file]: `${users[page] ?? ""}\n${line}\n` }), `${file}: ${line}`)
        .toEqual([`${file}:4: imports "lucide-react" directly — import the glyph from components/icons.ts`]);
    }
  }
});

test("a comment or a string that only mentions lucide-react is not an import", () => {
  expect(checkIconImports({ [ICONS]: icons, [page]: `${users[page]}// import { X } from "lucide-react";\nconst set = "lucide-react";\n` })).toEqual([]);
});

test("icons.ts holds only named re-exports from lucide-react", () => {
  for (const extra of [
    'import { Search as S } from "lucide-react";\nexport const MAP = { search: S };',
    'export const ICON_MAP = { search: "Search" };',
    'export function Glyph() { return null; }',
    'export * from "lucide-react";',
    'export { Check } from "./other.js";',
  ]) {
    const findings = checkIconImports({ [ICONS]: `${icons}${extra}\n`, ...users });
    expect(findings.length, extra).toBeGreaterThan(0);
    expect(findings.every((f) => f.startsWith(`${ICONS}:`)), extra).toBe(true);
  }
});

test("a re-exported name no other file imports is a finding", () => {
  expect(checkIconImports({ [ICONS]: 'export { Search, X, Trash2 } from "lucide-react";\nexport type { LucideIcon } from "lucide-react";\n', ...users }))
    .toEqual([`${ICONS}:1: Trash2 is re-exported but no other file under packages/ui-react/src imports it — remove it`]);
});

test("an aliased import counts for the name it imports", () => {
  expect(checkIconImports({ [ICONS]: 'export { Activity } from "lucide-react";\n', [page]: 'import { Activity as ActivityIcon } from "../icons.js";\n' })).toEqual([]);
});
