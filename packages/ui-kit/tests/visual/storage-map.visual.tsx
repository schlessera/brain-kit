/**
 * Storage map ownership baselines (#4544).
 *
 * The map's claim is paint: ownership by tint, edge pattern and label with no
 * hatching (#4537 D8), and the greyscale capture the acceptance criteria name,
 * where only the edge and the owner letter can tell Brain, App and Operator
 * apart. The stories' play functions measure the geometry (62 × 40 labels,
 * 44 × 44 targets, reading-order arrows); these baselines are for what a
 * measurement cannot see: a dash pattern collapsing into a line, a tint gone,
 * a legend chip losing its edge sample.
 *
 * Each subject renders the real story through CSF Next's `run()` at its own
 * width. Like every baseline here, generate and compare them only inside the
 * pinned Playwright image (`node scripts/visual.mjs --project=visual
 * --filter=storage-map --update`).
 */
/// <reference types="@vitest/browser/matchers" />
import { afterAll, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import * as breakdown from "../../stories/storage/StorageBreakdown.stories.js";
import * as storageMap from "../../stories/storage/StorageMap.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

/** The suite's tolerance (`subjects.visual.tsx` explains both numbers). */
const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

let viewport: { width: number; height: number };
let outer: { width: number; height: number } | undefined;
beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await document.fonts.ready;
});
afterAll(async () => {
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});

async function capture(story: unknown, name: string, width: 320 | 1280, theme: "dark" | "light", map = true) {
  // The outer page is sized too, so Vitest never scales the iframe: a scale
  // left over from an earlier file moves the dotted and dashed edges by a
  // fraction of a pixel and the capture would depend on file order.
  const before = await commands.formViewport(width, 800);
  outer ??= before;
  await page.viewport(width, 800);
  scrollTo(0, 0);
  await (story as ComposedStory).run({ globals: { theme } });
  expect(getComputedStyle(document.documentElement).colorScheme, "painted in the intended theme").toBe(theme);
  const frame = document.querySelector<HTMLElement>("[data-storage-frame]");
  expect(frame, "the story rendered its frame").not.toBeNull();
  // Park the real pointer on the frame's padding: an earlier file can leave it
  // over what is now a row, and a hovered row would be captured.
  await userEvent.hover(page.elementLocator(frame!), { position: { x: 2, y: 2 } });
  if (map) expect(document.querySelectorAll(".bk-storage-tile").length, "the map drew tiles").toBeGreaterThan(0);
  await expect(document.body).toMatchScreenshot(`storage-${name}-${width}${theme === "light" ? "-light" : ""}`, TOLERANCE);
}

test("storage map: greyscale owners, phone", async () => {
  await capture(storageMap.Greyscale, "map-greyscale", 320, "dark");
});

test("storage map: greyscale owners, desktop, paper", async () => {
  await capture(storageMap.GreyscaleDesktop, "map-greyscale", 1280, "light");
});

test("storage map: app dominant, desktop", async () => {
  await capture(storageMap.AppDominantDesktop, "map-app-dominant", 1280, "dark");
});

test("storage breakdown: side by side, desktop", async () => {
  await capture(breakdown.AllDesktop, "breakdown-all", 1280, "dark");
});

test("storage breakdown: side by side, desktop, paper", async () => {
  await capture(breakdown.AllDesktop, "breakdown-all", 1280, "light");
});

test("storage breakdown: partial with unknown rows, phone", async () => {
  await capture(breakdown.PartialWithUnknown, "breakdown-partial", 320, "dark");
});

test("storage breakdown: drilled three levels, phone, paper", async () => {
  await capture(breakdown.DrilledThreeLevels, "breakdown-drilled", 320, "light");
});

test("storage filter rows: selection bar, phone", async () => {
  await capture(breakdown.FilterWithSelection, "filter-selection", 320, "dark", false);
});

test("storage filter rows: one row of columns, desktop, paper", async () => {
  await capture(breakdown.FilterWithSelectionDesktop, "filter-selection", 1280, "light", false);
});

// Tiles a few pixels wide keep their owner's edge at 1px and their computed box (#4559 review F1, F2).
test("storage map: thin tiles keep their edges, phone", async () => {
  await capture(storageMap.ThinTiles, "map-thin-tiles", 320, "dark");
});
