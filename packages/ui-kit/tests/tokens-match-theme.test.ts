/**
 * `src/theme.css` holds the ~115 values the kit renders; `src/tokens.ts` holds
 * a mirror of them, which is what gives the token names a type and this test
 * something to compare against. Two copies of a value is exactly how a design
 * system drifts, so they are pinned together here — in BOTH directions, because
 * a token defined in the stylesheet and never referenced is as much a defect as
 * one referenced and never defined.
 *
 * The companion assertion is that no `.tsx` may contain a colour literal.
 * Without it the routing is a convention, and the whole point of moving the
 * tone tables into the stylesheet is that the light theme the design has now
 * published becomes a block of values rather than an edit to 58 components.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

import { TOKENS, accent, color, token } from "../src/tokens.js";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SRC = join(PACKAGE_ROOT, "src");
const theme = readFileSync(join(SRC, "theme.css"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({
  name: relative(PACKAGE_ROOT, path),
  // Block comments carry example values (`amber: '#e09f3e'`) documenting what
  // was hoisted out; stripping them is what lets those examples stay.
  code: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
}));

/** Declarations, not uses: `--bk-x: …` at the start of a declaration. */
const DECLARED = new Map(
  [...theme.matchAll(/^\s*(--bk-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]),
);

describe("tokens match the stylesheet", () => {
  test("the parser found the stylesheet's tokens", () => {
    // A guard on the guard: if the declaration regex stopped matching, every
    // assertion below would compare against an empty map and pass vacuously.
    expect(DECLARED.size).toBe(Object.keys(TOKENS).length);
  });

  for (const [name, value] of Object.entries(TOKENS)) {
    test(`--bk-${name} is ${value} in both files`, () => {
      expect(DECLARED.get(`--bk-${name}`)).toBe(value);
    });
  }

  test("the stylesheet declares no --bk token the kit does not know about", () => {
    const orphans = [...DECLARED.keys()].filter((n) => !(n.slice("--bk-".length) in TOKENS));
    expect(orphans).toEqual([]);
  });

  test("no value carries a fallback", () => {
    // A fallback would let a consumer who forgot the stylesheet render in the
    // DARK palette whatever theme they asked for — a failure that looks
    // deliberate and ships. Without one they get a colourless page, which is
    // loud and gets fixed. The literals in TOKENS are the stylesheet's mirror,
    // not a rendered value, and this is what keeps them from becoming one.
    expect(token("color-amber")).toBe("var(--bk-color-amber)");
    expect(color.canvas).toBe("var(--bk-color-canvas)");
    expect(accent.teal.fill).toBe("var(--bk-teal-fill)");
    for (const name of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      expect(token(name)).not.toContain(",");
    }
  });

  test("an accent's three roles are three separate tokens", () => {
    // They are the same colour in the dark theme and three different ones on
    // paper: a darkened ink for text, the original fill for solid surfaces, and
    // a mid step for 6-8px marks, where a darkened accent reads black. Calling
    // them one token would work today and break the light theme.
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red", "neutral"] as const) {
      const roles = accent[tone];
      expect(new Set([roles.ink, roles.fill, roles.mark]).size).toBe(3);
    }
  });

  test("only tokens.ts may contain a colour literal", () => {
    const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\(/;
    const offenders = files.filter((f) => LITERAL.test(f.code) && !f.name.endsWith("tokens.ts"));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  test("every var() reached for in src/ is declared", () => {
    const referenced = new Set(
      files
        // tokens.ts BUILDS the reference (`var(--bk-${name}, …)`); it does not
        // make one, and the interpolation would read as a token named "--bk-".
        .filter((f) => !f.name.endsWith("tokens.ts"))
        .flatMap((f) => [...f.code.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])),
    );
    // --hv-* are set by the component on its own inline style and read by the
    // stylesheet's hover rule; they are deliberately not theme tokens.
    const undeclared = [...referenced].filter(
      (name) => !DECLARED.has(name) && !name.startsWith("--hv-"),
    );
    expect(undeclared).toEqual([]);
  });

  test("a token that refers to another names one that exists", () => {
    // Most hover values are an existing colour under a second name, so they
    // say `var(--bk-color-raised)` rather than restating a hex. That is only
    // safe if a typo is caught: an undefined reference inside a token renders
    // nothing at all, and the element quietly inherits.
    const references = Object.entries(TOKENS).flatMap(([name, value]) =>
      [...value.matchAll(/var\((--bk-[\w-]+)/g)].map((m) => `${name} -> ${m[1]}`),
    );
    expect(references.length).toBeGreaterThan(10);
    expect(references.filter((r) => !DECLARED.has(r.split(" -> ")[1]))).toEqual([]);
  });

  test("the light theme has somewhere to land", () => {
    // Not authored this wave — the names and the dark values are what make it a
    // token file next wave rather than 58 component edits. This asserts the
    // mechanism is documented so the next author does not invent a different one.
    expect(theme).toContain('[data-theme="light"]');
  });
});
