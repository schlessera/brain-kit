/**
 * Spoken-turn details without the glyph (#3728): one baseline per state of the
 * `Voice/Chat marks` Details stories, at 320px and at a desktop width, in both
 * themes. The states are rest, the Details stop focused, the pill on hover,
 * the long-press pressed frame, the open details, and a right-click with a
 * selection inside the turn (whose native menu the page cannot draw, so the
 * baseline is the selection the menu would copy).
 *
 * This follows `voice.visual.tsx`: each story renders through CSF Next's
 * `run()`, play function included, so the baseline is of exactly what
 * Storybook shows; the viewport stays 720px tall; motion is emulated as reduced
 * through the real media query, which must produce the static form on its own
 * (no fade on the pill); and the tolerance is the same 0.01 threshold and 0.1%
 * ratio, generated and compared only inside the pinned Playwright image.
 */
/// <reference types="@vitest/browser/matchers" />
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";

import * as marks from "../../stories/voice/ChatMarks.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

const before = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  getSelection()?.removeAllRanges();
  await commands.dictationMotion("no-preference");
  await page.viewport(before.width, before.height);
});

async function render(story: unknown, theme: "dark" | "light", width: number) {
  await commands.dictationMotion("reduce");
  await page.viewport(width, 720);
  await (story as ComposedStory).run({ globals: { theme } });
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
  for (const stop of document.querySelectorAll(".bk-transcript-reveal")) {
    expect(getComputedStyle(stop).transitionDuration, "the pill appears without fading").toBe("0s");
  }
  expect(document.querySelector(".bk-transcript-glyphs"), "no evidence glyph").toBeNull();
}

const STATES = [
  [marks.DetailsAtRest, "rest"],
  [marks.DetailsFocused, "focused"],
  [marks.DetailsHover, "hover"],
  [marks.DetailsPressed, "pressed"],
  [marks.DetailsOpen, "open"],
  [marks.DetailsRightClickSelection, "selection"],
] as const;

const WIDTHS = [[320, "320"], [1280, "desktop"]] as const;

for (const theme of ["dark", "light"] as const) {
  for (const [width, size] of WIDTHS) {
    for (const [story, state] of STATES) {
      test(`spoken-turn details, ${state}, ${size}, ${theme}`, async () => {
        await render(story, theme, width);
        await expect(document.body).toMatchScreenshot(`voice-turn-details-${state}-${size}-${theme}`, TOLERANCE);
      });
    }
  }
}
