/**
 * The hold-to-talk `MicButton` in the real composer: visual baselines (#3727).
 *
 * One baseline per state, D1 rest, S1 holding with the hint, S1 with "Talk
 * live…" focused, D6 review on one line and on three, and the offline "Record
 * on this device" mic, at 320px and at a desktop width, in both themes.
 *
 * Each state is captured from its cell in `AllStates`, rendered through CSF
 * Next's `run()`, so the baseline is exactly what Storybook shows. On the
 * desktop the cells are the 720px composer column. The viewport stays 720px
 * tall, so the runner never scales the frame down.
 *
 * Motion is emulated as reduced through the real media query, as
 * `voice.visual.tsx` does, so the ring is one still frame. Tolerance and
 * determinism follow `subjects.visual.tsx`: generated and compared only inside
 * the pinned Playwright image.
 *
 * The composer without `micControl` is unchanged: every existing baseline
 * that draws it stays byte-identical in the same run.
 */
/// <reference types="@vitest/browser/matchers" />
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";

import * as composerMic from "../../stories/chrome/ComposerMic.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

const before = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  await commands.dictationMotion("no-preference");
  await page.viewport(before.width, before.height);
});

const WIDTHS = [[320, "320"], [1280, "desktop"]] as const;

for (const theme of ["dark", "light"] as const) {
  for (const [width, size] of WIDTHS) {
    test(`composer with MicButton, every state, ${size}, ${theme}`, async () => {
      await commands.dictationMotion("reduce");
      await page.viewport(width, 720);
      await (composerMic.AllStates as unknown as ComposedStory).run({ globals: { theme } });
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
      for (const ring of document.querySelectorAll(".bk-voice-ring-fill")) expect(getComputedStyle(ring).transitionDuration, "no easing").toBe("0s");

      const cells = [...document.querySelectorAll<HTMLElement>("[data-state]")];
      expect(cells).toHaveLength(6);
      for (const cell of cells) {
        const id = cell.dataset.state!.toLowerCase();
        if (id === "s1-talk-live") {
          const talk = cell.querySelector<HTMLButtonElement>(".bk-voice-talk-live")!;
          talk.focus();
          expect(talk.matches(":focus-visible"), "Talk live… shown by keyboard focus").toBe(true);
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        expect(cell.getBoundingClientRect().height, `${id} fits the viewport`).toBeLessThan(720);
        await expect(cell).toMatchScreenshot(`composer-mic-${id}-${size}-${theme}`, TOLERANCE);
      }
    });
  }
}
