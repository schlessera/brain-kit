/**
 * The voice surface's visual baselines (#3692).
 *
 * One baseline per state: every dictation (D1–D8), Start (S1–S5, with S2's
 * two forms and S3b–S3d) and live (L1–L10) state, at 320px and at a desktop
 * width, in both themes; the spoken-turn marks and the voice controls the same
 * way; and the three assembled voice screens in both themes.
 *
 * Each state is captured from its cell in the group's `AllStates` story,
 * rendered through CSF Next's `run()`, so the baseline is of exactly what
 * Storybook shows. At 320px a cell is the full phone column; at 1280px the
 * sheet lays states out in columns about a desktop composer's width, which is
 * how the field reflows there. The viewport stays 720px tall, so the runner
 * never scales the frame down and a baseline keeps its real pixels.
 *
 * Motion is emulated as reduced while capturing, through the real media query.
 * The meter, sweep, cursor and spinners then hold still, so a baseline is one
 * deterministic frame; the moving forms are covered by the stories' play
 * functions. It is restored after every test.
 *
 * Tolerance and determinism follow `subjects.visual.tsx`: the same 0.01
 * threshold and 0.1% ratio, generated and compared only inside the pinned
 * Playwright image.
 */
/// <reference types="@vitest/browser/matchers" />
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";

import * as dictation from "../../stories/voice/Dictation.stories.js";
import * as start from "../../stories/voice/Start.stories.js";
import * as live from "../../stories/voice/Live.stories.js";
import * as marks from "../../stories/voice/ChatMarks.stories.js";
import * as controls from "../../stories/voice/Controls.stories.js";
import * as screens from "../../stories/screens/Voice.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

const before = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  await commands.dictationMotion("no-preference");
  await page.viewport(before.width, before.height);
});

async function render(story: unknown, theme: "dark" | "light", width: number, height = 720) {
  await commands.dictationMotion("reduce");
  await page.viewport(width, height);
  await (story as ComposedStory).run({ globals: { theme } });
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme);
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
  reducedByTheMediaQuery();
}

/**
 * The stories show reduced motion through `data-motion="reduce"`; here the
 * real media query has to produce the same static form on its own: no bars
 * (one level line), no sweep, nothing turning or blinking, no easing.
 */
function reducedByTheMediaQuery() {
  const style = (selector: string) => [...document.querySelectorAll(selector)].map((el) => getComputedStyle(el));
  for (const s of style(".bk-voice-bars, .bk-voice-sweep")) expect(s.display, "moving meter hidden").toBe("none");
  for (const s of style(".bk-voice-level")) expect(s.display, "static level line").toBe("block");
  for (const s of style(".bk-voice-spin, .bk-voice-ctl-spin, .bk-voice-cursor")) expect(s.animationName, "nothing turns or blinks").toBe("none");
  for (const s of style(".bk-voice-ring-fill, .bk-voice-field")) expect(s.transitionDuration, "no easing").toBe("0s");
}

const GROUPS = [
  [dictation.AllStates, "voice-dictation", 8],
  [start.AllStates, "voice-start", 9],
  [live.AllStates, "voice-live", 10],
] as const;

const WIDTHS = [[320, "320"], [1280, "desktop"]] as const;

for (const theme of ["dark", "light"] as const) {
  for (const [width, size] of WIDTHS) {
    for (const [story, group, count] of GROUPS) {
      test(`${group}, every state, ${size}, ${theme}`, async () => {
        await render(story, theme, width);
        const cells = [...document.querySelectorAll<HTMLElement>("[data-state]")];
        expect(cells).toHaveLength(count);
        for (const cell of cells) {
          const id = cell.dataset.state!.replace("+", "-several").toLowerCase();
          expect(cell.getBoundingClientRect().height, `${id} fits the viewport`).toBeLessThan(720);
          await expect(cell).toMatchScreenshot(`${group}-${id}-${size}-${theme}`, TOLERANCE);
        }
      });
    }
    for (const [story, name] of [[marks.AllMarks, "voice-chat-marks"], [controls.ControlButtons, "voice-controls"], [controls.MicPhases, "voice-mic"]] as const) {
      test(`${name}, ${size}, ${theme}`, async () => {
        await render(story, theme, width);
        await expect(document.body).toMatchScreenshot(`${name}-${size}-${theme}`, TOLERANCE);
      });
    }
  }
  // The phone screens are taller than the runner's frame, as every assembled
  // screen's baseline is; they are compared at that one scale.
  for (const [story, name] of [[screens.Dictating, "voice-screen-dictating"], [screens.Starting, "voice-screen-starting"], [screens.LiveSpeaking, "voice-screen-live"]] as const) {
    test(`${name}, ${theme}`, async () => {
      await render(story, theme, 900, 1000);
      await expect(document.body).toMatchScreenshot(`${name}-${theme}`, TOLERANCE);
    });
  }
}
