/// <reference types="@vitest/browser/matchers" />
/**
 * #4216: curated receipt paint at 320px, paper and dark. Mixed owns the
 * operation/decision/target and muted review hierarchy; LongTarget owns
 * wrapping a 200-character id. The plays own copy and geometry. Review
 * captures include all seven scenarios at 320px and the 680px desktop column.
 */
import { describe, expect, test } from "vitest";
import { commands, page } from "vitest/browser";

import * as stories from "../../stories/google/GoogleJournalCalls.stories.js";

interface Runnable {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}
const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;
const STORIES = (Object.entries(stories) as [string, unknown][]).filter((entry): entry is [string, Runnable] => typeof (entry[1] as unknown as Runnable).run === "function");

async function runAt(story: Runnable, width: number, theme: "dark" | "light", body: (frame: HTMLElement) => Promise<void>) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  const outer = await commands.formViewport(width === 320 ? 320 : 760, 1000);
  try {
    await page.viewport(width === 320 ? 320 : 760, 1000);
    await story.run({ globals: { theme } });
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme);
    const frame = document.querySelector<HTMLElement>("[data-google-journal-frame]")!;
    expect(frame.getBoundingClientRect().width).toBe(width);
    await body(frame);
  } finally {
    await page.viewport(before.width, before.height);
    await commands.formViewport(outer.width - 100, outer.height - 120);
  }
}

const BASELINES = [
  [stories.MixedNarrow, "google-journal-mixed-phone"],
  [stories.LongTargetNarrow, "google-journal-long-target-phone"],
] as const;

describe("baselines", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [story, name] of BASELINES) {
      test(`${name}${theme === "light" ? ", on paper" : ""}`, async () => {
        await runAt(story as unknown as Runnable, 320, theme, async (frame) => {
          await expect(frame).toMatchScreenshot(`${name}${theme === "light" ? "-light" : ""}`, TOLERANCE);
        });
      });
    }
  }
});

describe("review captures", () => {
  test("all seven scenarios have both widths", () => {
    expect(STORIES.map(([name]) => name).sort()).toEqual([
      "Empty", "EmptyNarrow", "EveryDecision", "EveryDecisionNarrow", "LongTarget", "LongTargetNarrow", "Mixed", "MixedNarrow",
      "TaintedDeclined", "TaintedDeclinedNarrow", "Truncated", "TruncatedNarrow", "UnknownOperation", "UnknownOperationNarrow",
    ]);
  });
  for (const theme of ["dark", "light"] as const) {
    for (const [name, story] of STORIES) {
      const narrow = name.endsWith("Narrow");
      const base = narrow ? name.slice(0, -"Narrow".length) : name;
      const width = narrow ? 320 : 680;
      test(`${base} at ${width}, ${theme === "light" ? "paper" : "dark"}`, async () => {
        await runAt(story, width, theme, async (frame) => {
          await page.screenshot({ element: frame, path: `../../.vitest-attachments/google-journal-calls/${base}-${theme === "light" ? "paper" : "dark"}-${width}.png` });
        });
      });
    }
  }
});
