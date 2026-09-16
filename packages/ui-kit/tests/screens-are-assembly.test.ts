/**
 * WAVE 5'S ACCEPTANCE TEST, AS A GATE.
 *
 * The design states the terms for its four assembled screens: *"pure
 * composition: no new colours, no new type sizes, no bespoke markup beyond
 * layout. This is the test the kit has to pass."* If a screen needs a new
 * component or a one-off style, the component set is wrong and we fix the set,
 * not the screen.
 *
 * That claim is about the SOURCE of a screen, not about its rendered tree — a
 * DOM scan cannot tell a `<div>` the screen authored from one a component
 * rendered, and every component paints colours inline by design. So this reads
 * `stories/screens/*.stories.tsx` and holds three properties over the text:
 *
 *   1. **Every capitalised JSX tag is imported from `src/`.** A screen may not
 *      define a component, and may not reach for story furniture other than the
 *      phone frame (D16 — `PhoneFrame` is a device mock, not a shipped thing).
 *   2. **Every inline style declares layout and nothing else.** The allowlist
 *      below is the whole vocabulary a flex container needs. A `color`, a
 *      `font`, a `background` or a `border` in a screen is a design decision
 *      being made in the wrong file.
 *   3. **No colour literal anywhere.** `src/` already has this rule via
 *      `tokens-match-theme.test.ts`; screens are the other place a hex can
 *      appear and look harmless.
 *
 * The gate is over the whole directory rather than a named list, so screens 2-4
 * inherit it by existing.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SCREENS = join(PACKAGE_ROOT, "stories", "screens");

/**
 * Layout, and only layout. Anything a flex or grid container needs to place its
 * children, plus the box properties that keep a screen inside its frame.
 */
const LAYOUT_PROPERTIES = new Set([
  "display",
  "flex",
  "flexDirection",
  "flexWrap",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "gap",
  "rowGap",
  "columnGap",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "marginTop",
  "marginBottom",
  "padding",
  "boxSizing",
  "overflow",
  "minWidth",
  "minHeight",
  "width",
  "height",
  "position",
]);

/** `#abc`, `#aabbcc`, `rgb(`, `rgba(`, `hsl(` — every way a colour gets typed. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

const files = readdirSync(SCREENS)
  .filter((entry) => entry.endsWith(".stories.tsx"))
  .map((entry) => ({
    name: entry,
    code: readFileSync(join(SCREENS, entry), "utf8"),
  }));

/** Comments carry prose about colours and about the catalog's own literals. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the assembled screens are assembly", () => {
  test("there are screens to check", () => {
    // A guard on the guard: an empty directory would pass every assertion below
    // without inspecting anything, which is how a gate quietly stops being one.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const code = stripComments(file.code);

    test(`${file.name} renders only components the kit owns`, () => {
      const imported = new Map<string, string>();
      for (const m of code.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)) {
        for (const name of m[1]!.split(",")) {
          const bare = name.trim().replace(/^type\s+/, "").split(" as ").pop()!.trim();
          if (bare) imported.set(bare, m[2]!);
        }
      }

      const offenders: string[] = [];
      for (const m of code.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) {
        const tag = m[1]!;
        const from = imported.get(tag);
        if (from === undefined) {
          offenders.push(`<${tag}> is not imported — a screen may not define a component`);
        } else if (!from.startsWith("../../src/")) {
          offenders.push(`<${tag}> comes from ${from}, not from the kit`);
        }
      }
      expect(offenders).toEqual([]);
    });

    test(`${file.name} styles layout and nothing else`, () => {
      const offenders: string[] = [];
      // `style={{ … }}` up to the matching pair of braces. Screens nest no
      // object inside a style object, and the assertion above keeps it that way
      // by refusing anything but flex containers in the first place.
      for (const m of code.matchAll(/style=\{\{([^{}]*)\}\}/g)) {
        for (const prop of m[1]!.matchAll(/([A-Za-z]+)\s*:/g)) {
          const name = prop[1]!;
          if (!LAYOUT_PROPERTIES.has(name)) {
            offenders.push(`${name} — a screen may only declare layout`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    test(`${file.name} names no colour`, () => {
      const hits = code.split("\n").flatMap((line, i) => (COLOUR.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
      expect(hits).toEqual([]);
    });
  }
});
