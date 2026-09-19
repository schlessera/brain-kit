import { describe, expect, test } from "bun:test";
import { LIGHT_TOKENS, TOKENS } from "@schlessera/brain-ui-kit";

import { readToken, resolveLightDark } from "../src/lib/light-dark.js";

/**
 * The canvas reads tokens as values, and since the kit's light theme every
 * token is `light-dark(<paper>, <dark>)` — which `getComputedStyle` returns
 * verbatim and a canvas `fillStyle` silently rejects. The first browser
 * check after D39 found the graph's labels drawn in the canvas default
 * black on the dark ground for exactly that reason. This is the resolver
 * that splits the expression; the theme tests above it prove nothing
 * unresolved reaches sigma or mermaid.
 */
describe("resolveLightDark", () => {
  test("picks the half for the scheme", () => {
    expect(resolveLightDark("light-dark(#231f1a, #e8e4df)", "light")).toBe("#231f1a");
    expect(resolveLightDark("light-dark(#231f1a, #e8e4df)", "dark")).toBe("#e8e4df");
  });

  test("splits at the top-level comma only, so an rgba() half stays whole", () => {
    const value = "light-dark(rgba(35,31,26,0.16), rgba(224,159,62,0.14))";
    expect(resolveLightDark(value, "light")).toBe("rgba(35,31,26,0.16)");
    expect(resolveLightDark(value, "dark")).toBe("rgba(224,159,62,0.14)");
  });

  test("a value that is not a pair comes back as it is", () => {
    expect(resolveLightDark("#e09f3e", "light")).toBe("#e09f3e");
    expect(resolveLightDark("  rgba(1,2,3,0.5) ", "dark")).toBe("rgba(1,2,3,0.5)");
  });
});

describe("readToken", () => {
  test("falls back to the kit's tables where there is no document", () => {
    expect(readToken("canvas-slot-1", "dark")).toBe(TOKENS["canvas-slot-1"]);
    expect(readToken("canvas-slot-1", "light")).toBe(LIGHT_TOKENS["canvas-slot-1"]);
    expect(readToken("color-ink", "light")).toBe("#231f1a");
  });

  test("never returns an unresolved expression for any token", () => {
    for (const name of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      for (const scheme of ["light", "dark"] as const) {
        expect(readToken(name, scheme)).not.toContain("light-dark(");
      }
    }
  });
});
