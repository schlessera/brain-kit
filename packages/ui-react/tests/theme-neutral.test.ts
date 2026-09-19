/**
 * The app draws no colour of its own. Every utility colour in `theme.css` is
 * one of the kit's `--bk-*` tokens, and every component class is one of those
 * utilities — so the kit's `light-dark()` switch (D32) reaches the whole app,
 * not only the kit components inside it.
 *
 * Why a static gate and not a screenshot: the app has no browser harness, and
 * the first light-mode check of the shell found the reason this test exists —
 * `@theme` held literal dark hex for `--color-surface`, `--color-foreground`
 * and the rest, so under `data-theme="light"` the kit's cards turned to paper
 * while the page around them stayed `#0c0e12`. A hex literal or a Tailwind
 * palette class is the only way that can happen again, and both are greppable.
 *
 * What is allowed, and why, is listed per file below. An entry is a decision
 * with a reason, not a wildcard: a new file with a hex in it fails here until
 * someone writes down why the colour cannot be a token.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

function sourceFiles(): string[] {
  const glob = new Glob("**/*.{ts,tsx}");
  return [...glob.scanSync({ cwd: SRC })].filter((f) => !f.endsWith(".d.ts")).sort();
}

/** Strips block and line comments so a hex in prose does not count. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

describe("theme.css", () => {
  const css = readFileSync(join(SRC, "theme.css"), "utf8");
  const body = withoutComments(css);

  test("carries no colour literal — every colour is var(--bk-*) or a color-mix of one", () => {
    const literals = body.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  test("every --color-* utility is defined over a kit token, inline", () => {
    const inline = body.match(/@theme inline \{([\s\S]*?)\n\}/);
    expect(inline).not.toBeNull();
    const declarations = [...inline![1]!.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)];
    expect(declarations.length).toBeGreaterThan(20);
    for (const [, name, value] of declarations) {
      expect(`${name}: ${value}`).toMatch(/^--color-[a-z-]+: (var\(--bk-[a-z-]+\)|color-mix\(in srgb, var\(--bk-[a-z-]+\) \d+%, transparent\))$/);
    }
    // And no colour is declared in the plain block, where a var() value would
    // resolve on :root instead of where the utility is used.
    const plain = body.match(/@theme \{([\s\S]*?)\n\}/);
    expect(plain).not.toBeNull();
    expect(plain![1]).not.toMatch(/--color-/);
  });
});

// Tailwind's own palette never appears: `text-amber-100` is light text that
// reads on a dark ground and vanishes on paper, and there is no token-free
// way to say "amber" that the light theme can follow.
const PALETTE =
  /\b(?:[a-z-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?\b/g;

// `black` and `white` with an alpha are a scrim — they darken whatever is
// behind them, in both themes, and the kit's own overlays do the same.
// Solid black or white is allowed only where the ground is not the theme's:
const SOLID_MONO = /\b(?:[a-z-]+:)*(?:bg|text|border)-(?:black|white)\b(?!\/)/g;
const SOLID_MONO_ALLOWED: Record<string, string> = {
  "components/images/mask-editor.tsx": "the controls sit on the photograph, not on a surface",
  "components/files/file-viewer-html.tsx": "an HTML document assumes a white page behind it",
};

// Each of these draws outside the DOM — a canvas, an export — where a CSS
// token cannot reach AND the colour is not the theme's. The graph canvas and
// the mermaid theme also draw outside the DOM, but their colours ARE the
// theme's: the kit's `--bk-canvas-*` and `--bk-diagram-*` tokens, read as
// values through `lib/light-dark.ts` for the scheme in force, so no hex of
// theirs lives here any more.
const HEX_ALLOWED: Record<string, string> = {
  "components/images/mask-editor.tsx": "the mask bitmap is white-on-black by contract",
  "lib/image-optimize.ts": "export canvas flattens transparency onto white",
};

describe("component classes", () => {
  test("no Tailwind palette colour anywhere in src", () => {
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      const code = withoutComments(readFileSync(join(SRC, file), "utf8"));
      for (const m of code.matchAll(PALETTE)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });

  test("solid black or white only where the ground is not the theme's", () => {
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      if (file in SOLID_MONO_ALLOWED) continue;
      const code = withoutComments(readFileSync(join(SRC, file), "utf8"));
      for (const m of code.matchAll(SOLID_MONO)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("hex literals in source", () => {
  test("no hex outside the files that draw outside the DOM", () => {
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      if (file in HEX_ALLOWED) continue;
      const code = withoutComments(readFileSync(join(SRC, file), "utf8"));
      for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b/g)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });

  test("the allowlist names only files that still exist and still need it", () => {
    for (const file of Object.keys(HEX_ALLOWED)) {
      const code = withoutComments(readFileSync(join(SRC, file), "utf8"));
      expect(code, `${file} carries no hex any more — drop it from the allowlist`).toMatch(/#[0-9a-fA-F]{6}\b/);
    }
    for (const file of Object.keys(SOLID_MONO_ALLOWED)) {
      const code = withoutComments(readFileSync(join(SRC, file), "utf8"));
      // A fresh, non-global copy: a `g` regex keeps `lastIndex` between calls.
      expect(code, `${file} carries no solid black/white any more — drop it from the allowlist`).toMatch(new RegExp(SOLID_MONO.source));
    }
  });
});
