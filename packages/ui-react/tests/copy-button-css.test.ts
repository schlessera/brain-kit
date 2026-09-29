// The copy control is hover-revealed on a fine pointer and must stay visible
// on a coarse one (#580). happy-dom evaluates no media queries, so this
// compiles the control's own classes with the installed Tailwind and checks
// the stylesheet a phone receives: a class Tailwind does not know compiles to
// nothing, and the button would be invisible on touch again.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";

import { COPY_OVERLAY_CLASS } from "../src/components/chat/copy-button.js";

async function css(candidates: string[]): Promise<string> {
  const compiler = await compile('@import "tailwindcss/utilities.css";', {
    base: import.meta.dir,
    loadStylesheet: async (id, base) => {
      const path = Bun.resolveSync(id, base);
      return { path, base, content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(candidates);
}

/** The rules inside each `@media (<query>) { … }` block, flattened. */
function mediaBlock(sheet: string, query: string): string {
  const at = sheet.indexOf(`@media (${query})`);
  if (at === -1) return "";
  const end = sheet.indexOf("\n}", at);
  return sheet.slice(at, end);
}

describe("the copy overlay's stylesheet", () => {
  test("hides the control by default and reveals it under a coarse pointer", async () => {
    const sheet = await css(COPY_OVERLAY_CLASS.split(" "));
    expect(sheet).toMatch(/\.opacity-0 \{\s*opacity: 0%;/);
    const coarse = mediaBlock(sheet, "pointer: coarse");
    expect(coarse).toContain("opacity: 100%");
    // Hover only exists where the device can hover; it is not what a phone
    // gets. The group is named, so hovering an enclosing message bubble (an
    // unnamed `group`) does not reveal every copy button inside it.
    expect(mediaBlock(sheet, "hover: hover")).toContain(":where(.group\\/copy):hover");
    // The coarse rule comes after the default, so equal specificity lets it win.
    expect(sheet.indexOf("@media (pointer: coarse)")).toBeGreaterThan(sheet.indexOf(".opacity-0"));
  });
});
