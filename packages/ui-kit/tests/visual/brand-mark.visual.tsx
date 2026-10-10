/// <reference types="@vitest/browser/matchers" />
/**
 * BrandMark's painted colours (#1424), read from Chromium in each theme.
 *
 * The expected values are the hex codes #1423's spec gives for the logo inside
 * the app ("Inside the app", §4), written out here rather than read back from
 * the tokens the component paints with, so a token that drifts fails.
 */
import { expect, test } from "vitest";
import * as stories from "../../stories/primitives/BrandMark.stories.js";

const SPEC = {
  dark: { ink: "rgb(232, 228, 223)", accent: "rgb(224, 159, 62)" }, // #e8e4df, #e09f3e
  light: { ink: "rgb(35, 31, 26)", accent: "rgb(176, 109, 16)" }, // #231f1a, #b06d10
} as const;

for (const theme of ["dark", "light"] as const) {
  for (const [name, story, parts] of [
    ["mark", stories.Mark, ["ink", "accent"]],
    ["small mark", stories.MarkSmall, ["ink", "accent"]],
    ["lockup", stories.Lockup, ["ink", "accent", "wordmark"]],
  ] as const) {
    test(`${name} paints the spec's ${theme} colours`, async () => {
      await story.run({ globals: { theme } });
      expect(document.documentElement.dataset.theme).toBe(theme);
      const svg = document.querySelector<SVGSVGElement>("svg[data-brand-mark]");
      expect(svg).toBeTruthy();
      const painted = [...svg!.querySelectorAll<SVGPathElement>("path[data-part]")];
      expect(painted.map((p) => p.dataset.part)).toEqual([...parts]);
      for (const path of painted) {
        const want = path.dataset.part === "accent" ? SPEC[theme].accent : SPEC[theme].ink;
        expect(getComputedStyle(path).fill, `${path.dataset.part} fill`).toBe(want);
      }
    });
  }
}
