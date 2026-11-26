/**
 * ToolRow baselines (#4545): every state in one list, at 320px (stacked) and
 * at the 940px desktop column, in dark and paper; the same list with the hue
 * removed; and 200% zoom at 320px. The states' words and geometry are asserted
 * by the stories' own play functions; this file covers what was painted.
 */
/// <reference types="@vitest/browser/matchers" />
import { afterAll, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import * as stories from "../../stories/storage/ToolRow.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

/** The subjects file's tolerance, for the same reasons (subjects.visual.tsx). */
const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

let viewport: { width: number; height: number };
let outer: { width: number; height: number };
beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  // Wide enough that the 940px frame is never clipped, and an outer window
  // larger than the frame so Vitest does not scale the iframe down.
  outer = await commands.formViewport(1280, 2600);
  await page.viewport(1280, 2600);
});
afterAll(async () => {
  await page.viewport(viewport.width, viewport.height);
  await commands.formViewport(outer.width - 100, outer.height - 120);
});

async function capture(story: unknown, name: string, theme: string) {
  await (story as ComposedStory).run({ globals: { theme } });
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme);
  // The running stripe is the one moving paint; park it so the capture is stable.
  for (const stripe of document.querySelectorAll<HTMLElement>(".bk-tool-stripe")) stripe.style.animation = "none";
  const frame = document.querySelector<HTMLElement>("[data-tool-frame]");
  expect(frame).toBeTruthy();
  expect(frame!.getBoundingClientRect().bottom, "the whole list is inside the page, so nothing is cut").toBeLessThanOrEqual(innerHeight);
  // A preceding test can leave the pointer over a button; capture rest paint.
  await userEvent.unhover(frame!);
  await expect(frame!).toMatchScreenshot(`${name}-${theme}`, TOLERANCE);
}

const colour = { "tool-row-320": stories.EveryState, "tool-row-desktop": stories.EveryStateDesktop, "tool-row-zoom-200": stories.Zoom200 };
for (const theme of ["dark", "light"]) {
  for (const [name, story] of Object.entries(colour)) test(`${name} ${theme}`, () => capture(story, name, theme));
}
// Greyscale removes the only channel that differs between themes' hues, so
// one theme is the proof; dark is the default ground.
test("tool-row-greyscale-320 dark", () => capture(stories.Greyscale, "tool-row-greyscale-320", "dark"));
test("tool-row-greyscale-desktop dark", () => capture(stories.GreyscaleDesktop, "tool-row-greyscale-desktop", "dark"));
