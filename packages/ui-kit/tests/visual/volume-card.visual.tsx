/**
 * Visual baselines for the storage volume components (#4542): every
 * VolumeCard state at 320px and at desktop width, in dark and on paper, the
 * selected card's notch above the chart, and the greyscale captures that show
 * status, selection and segments surviving without colour.
 *
 * The baselines are of the real stories (CSF Next `run()`), so they cannot
 * drift from what Storybook shows. Geometry, the a11y gate and keyboard
 * selection are asserted by the stories' own play functions in both
 * Storybook projects; this file covers what those assertions cannot see,
 * which is the paint. Tolerances are `subjects.visual.tsx`'s, for its reasons.
 */
/// <reference types="@vitest/browser/matchers" />
import { afterAll, beforeAll, expect, test } from "vitest";
import { page } from "vitest/browser";

import * as gauge from "../../stories/storage/CapacityGauge.stories.js";
import * as card from "../../stories/storage/VolumeCard.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

let viewport: { width: number; height: number };
beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  // Wide enough for the 940px strip and the three-column phone sheet, and no
  // larger than the runner's 1280 × 720 window: a bigger viewport is scaled
  // down to fit it, and the capture with it.
  await page.viewport(1280, 720);
});
afterAll(async () => {
  await page.viewport(viewport.width, viewport.height);
});

/** The stage the story rendered into, or the subject itself when `self`. */
function stageOf(selector: string, self = false): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  expect(el, `${selector} rendered`).toBeTruthy();
  const stage = self ? el! : el!.parentElement!;
  // A capture taller than the viewport comes out blank below the fold.
  expect(stage.getBoundingClientRect().bottom, "the subject fits the viewport").toBeLessThanOrEqual(innerHeight);
  return stage;
}

async function looksRight(story: unknown, selector: string, name: string, theme: "dark" | "light") {
  await (story as ComposedStory).run({ globals: { theme } });
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme);
  await document.fonts.ready;
  await expect(page.elementLocator(stageOf(selector, selector === "[data-phone-sheet]"))).toMatchScreenshot(`${name}-${theme}`, TOLERANCE);
}

const SUBJECTS: Array<[string, unknown, string]> = [
  ["volume-cards-320", card.PhoneSheet, "[data-phone-sheet]"],
  ["volume-cards-desktop", card.AllStatesDesktop, ".bk-volume-group"],
  ["volume-group-desktop", card.GroupDesktop, ".bk-volume-group"],
  ["capacity-gauges-320", gauge.Greyscale, "[data-capacity-gauge]"],
];

for (const theme of ["dark", "light"] as const) {
  for (const [name, story, selector] of SUBJECTS) {
    test(`${name}, ${theme}`, async () => {
      await looksRight(story, selector, name, theme);
    });
  }
}

/** Greyscale, the claim being that meaning survives it: one theme is enough. */
test("volume cards in greyscale, desktop", async () => {
  await (card.Greyscale as unknown as ComposedStory).run({ globals: { theme: "dark" } });
  await document.fonts.ready;
  const grey = stageOf(".bk-volume-group");
  expect(getComputedStyle(grey).filter).toBe("grayscale(1)");
  await expect(page.elementLocator(grey)).toMatchScreenshot("volume-cards-greyscale", TOLERANCE);
});
