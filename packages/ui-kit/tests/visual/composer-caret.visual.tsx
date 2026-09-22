/**
 * The composer's caret at the cap, typed with REAL keys.
 *
 * `Composer` grows with the text it displays up to five rows and scrolls from
 * there (issue #92). The story that proves the cap cannot prove the caret:
 * `storybook/test`'s `userEvent` dispatches synthetic events and sets the
 * value through the DOM, and a browser scrolls a caret into view only when it
 * performs the edit itself. This file types through Playwright — a key press
 * the browser handles — and asserts what a person typing at the cap sees: the
 * last line, with the caret on it, not a field scrolled to its top while the
 * text goes in below the fold.
 *
 * It lives in the visual project because that is the runner with a real
 * keyboard, not because it takes a screenshot: the storybook project's
 * `userEvent` is testing-library's, and importing `@vitest/browser/context`
 * into a story would break `storybook dev` (see `subjects.visual.tsx`).
 */
// `vitest/browser`, not `@vitest/browser/context`: the same module — the
// config's `@vitest/browser-playwright` is what types it — reached through the
// entry that is not deprecated. The older specifier still resolves and warns.
import { userEvent } from "vitest/browser";
import { expect, test } from "vitest";

import * as composer from "../../stories/chrome/Composer.stories.js";

interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

test("composer: the caret stays in view while typing at the cap", async () => {
  await (composer.StopsAtTheCap as unknown as ComposedStory).run();
  const field = document.querySelector<HTMLTextAreaElement>("textarea.bk-composer");
  if (!field) throw new Error("the story rendered no composer field");

  // The story's own claims, so a caret assertion cannot pass on a field that
  // never reached the cap.
  expect(field.getBoundingClientRect().height).toBe(96);
  expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
  expect(field.scrollTop).toBe(0);

  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  await userEvent.keyboard(" Go.");

  expect(field.value.endsWith(" Go.")).toBe(true);
  expect(field.getBoundingClientRect().height).toBe(96);
  // The field scrolled, and what is left below the fold is less than a line:
  // Chromium brings the caret's LINE into view, not the box's bottom edge, so
  // a pixel or two of descender space may stay hidden. The caret is not.
  const line = 13.5 * 1.45;
  expect(field.scrollTop).toBeGreaterThan(0);
  expect(field.scrollHeight - (field.scrollTop + field.clientHeight)).toBeLessThan(line);
});
