/**
 * Reading a kit token as a VALUE, for the two places the app draws outside
 * the DOM: the sigma graph canvas and the mermaid diagram theme.
 *
 * Every `--bk-*` token is `light-dark(<paper>, <dark>)` (kit D32), and
 * `getComputedStyle` hands that expression back verbatim — a custom property
 * computes to its specified value, and the browser only picks the half when a
 * property that takes a colour consumes it. A canvas `fillStyle` never does:
 * it silently rejects the string and keeps whatever it held before, which is
 * how the graph's labels came to draw in the canvas default black on a dark
 * ground. So the app splits the expression itself, on the scheme the
 * element's `color-scheme` resolves to.
 *
 * Pure functions here; `hooks/use-color-scheme.ts` decides which half.
 */

import { LIGHT_TOKENS, TOKENS, type TokenName } from "@schlessera/brain-ui-kit";

export type ColorScheme = "light" | "dark";

/** Splits `a, b` at the top-level comma, so `rgba(1,2,3,.4)` stays whole. */
function halves(inner: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  return null;
}

/**
 * The half of a `light-dark(<light>, <dark>)` expression for a scheme. A
 * value that is not one — a bare hex, an rgba, a token the kit spells the
 * same in both themes — comes back unchanged.
 */
export function resolveLightDark(value: string, scheme: ColorScheme): string {
  const trimmed = value.trim();
  const m = /^light-dark\((.*)\)$/s.exec(trimmed);
  if (!m) return trimmed;
  const pair = halves(m[1]!);
  if (!pair) return trimmed;
  return scheme === "light" ? pair[0] : pair[1];
}

/**
 * Which half the document is showing: the root's computed `color-scheme`,
 * with `light dark` (the kit's `data-theme="system"`) and anything else the
 * browser reports (`normal`, `only light`) settled by `prefers-color-scheme`.
 */
export function documentColorScheme(): ColorScheme {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "dark";
  const declared = getComputedStyle(document.documentElement).colorScheme?.trim() ?? "";
  const words = declared.split(/\s+/).filter((w) => w === "light" || w === "dark");
  if (words.length === 1) return words[0] as ColorScheme;
  return prefersDark() ? "dark" : "light";
}

export function prefersDark(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}

/**
 * A kit token's value in one scheme: the stylesheet's declaration, resolved,
 * so a host that re-points a token is honoured; the kit's own table where
 * there is no document (a test, a server) or the stylesheet is not loaded.
 */
export function readToken(name: TokenName, scheme: ColorScheme): string {
  if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
    const declared = getComputedStyle(document.documentElement).getPropertyValue(`--bk-${name}`);
    if (declared.trim()) return resolveLightDark(declared, scheme);
  }
  return resolveLightDark(scheme === "light" ? LIGHT_TOKENS[name] : TOKENS[name], scheme);
}
