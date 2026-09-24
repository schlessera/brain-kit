/**
 * `src/tokens.css`, parsed: every `--bk-*` declaration in the `:root` block as
 * its two halves. The `[data-theme="print"]` block is left out: it re-declares
 * the same names with plain values and has its own test. Shared by the token tests so that all of them read the
 * stylesheet the same way — `light-dark(<light>, <dark>)` or a bare value
 * that is the same in both themes.
 *
 * `theme` is the tokens file; `tailwindTheme` is `src/theme.css`, the
 * Tailwind entry that imports it and adds the `@theme static` scales.
 */
import { readFileSync } from "fs";
import { join, resolve } from "path";

import { splitPrintBlock } from "../tools/theme/derive-print.js";

export const PACKAGE_ROOT = resolve(import.meta.dir, "..");
export const theme = readFileSync(join(PACKAGE_ROOT, "src", "tokens.css"), "utf8");
export const tailwindTheme = readFileSync(join(PACKAGE_ROOT, "src", "theme.css"), "utf8");

export interface Declared {
  light: string;
  dark: string;
  /** The declaration's value as written. */
  raw: string;
}

/** Splits `a, b` at the top-level comma, so `rgba(1,2,3,.4)` stays whole. */
function halves(inner: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  throw new Error(`not two halves: ${inner}`);
}

export function parseDeclaration(raw: string): Declared {
  const m = /^light-dark\((.*)\)$/.exec(raw);
  if (!m) return { light: raw, dark: raw, raw };
  const [light, dark] = halves(m[1]!);
  return { light, dark, raw };
}

/** Declarations, not uses: `--bk-x: …` at the start of a declaration. */
export const DECLARED = new Map<string, Declared>(
  [...splitPrintBlock(theme).outside.matchAll(/^\s*(--bk-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1]!, parseDeclaration(m[2]!.trim())]),
);
