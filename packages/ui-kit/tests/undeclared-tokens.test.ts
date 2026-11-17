/**
 * Every `var(--bk-…)` the kit reads must be declared somewhere the kit ships.
 *
 * A shorthand such as `font: 500 12.5px/20px var(--bk-font-body)` that names
 * an undeclared custom property is invalid at computed-value time, so the
 * whole declaration falls back to `unset`. `font` inherits, and the button
 * silently renders in its parent's type instead of its own. Nothing else
 * notices: the rule is present, the selector matches, and every prop-level
 * test passes. `TextButton` shipped exactly that from #1455 until #3752.
 *
 * Declared means one of:
 * - a `--bk-name:` declaration in the kit's CSS, or
 * - a custom property a component sets inline (`"--bk-name": …` in a style
 *   object), which is the kit's documented way to pass a per-instance value.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

import { PACKAGE_ROOT } from "./_theme.js";

// The stories are scanned too: a story that styles its own fixture with a
// misspelt token (`--bk-ink` for `--bk-color-ink`) paints the browser default
// just as silently, and documents a component nobody ships.
const ROOTS = ["src", "stories", ".storybook"].map((dir) => join(PACKAGE_ROOT, dir));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(entry) ? [path] : [];
  });
}

const sources = ROOTS.flatMap(files).map((path) => ({
  name: relative(PACKAGE_ROOT, path),
  // Comments document token names in prose; only code may count.
  code: readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(path.endsWith(".css") ? /$^/ : /(^|[^:"'`])\/\/.*$/gm, "$1"),
}));

const declared = new Set<string>();
for (const { code } of sources) {
  for (const m of code.matchAll(/(--bk-[\w-]+)\s*:/g)) declared.add(m[1]!);
  for (const m of code.matchAll(/["'`](--bk-[\w-]+)["'`]\s*[\]:,)]/g)) declared.add(m[1]!);
}

const read = new Map<string, Set<string>>();
for (const { name, code } of sources) {
  for (const m of code.matchAll(/var\(\s*(--bk-[\w-]+)/g)) {
    if (!read.has(m[1]!)) read.set(m[1]!, new Set());
    read.get(m[1]!)!.add(name);
  }
}

describe("custom properties the kit reads", () => {
  test("the scan found the stylesheet", () => {
    // A guard on the guard: an empty scan would pass vacuously.
    expect(declared.size).toBeGreaterThan(100);
    expect(read.size).toBeGreaterThan(50);
  });

  test("every var(--bk-…) is declared by the kit", () => {
    const undeclared = [...read]
      .filter(([token]) => !declared.has(token))
      .map(([token, where]) => `${token} (read in ${[...where].sort().join(", ")})`)
      .sort();
    expect(undeclared).toEqual([]);
  });
});
