import { beforeAll, expect } from "vitest";

// The story projects launch Chromium without reduced-motion emulation, and
// every story file shares that one page. A fixture that emulates it through
// `commands.consumerParityViewport` must restore it in its own test: Storybook
// runs a `beforeEach` cleanup only when the next story loads, so the last
// story of a file never runs its own. A leak turns every later file's CSS
// animations into zero-length ones and fails frame-timing proof far from its
// cause (#4582). Name the leak where it lands instead.
beforeAll(async () => {
  await expect(
    matchMedia("(prefers-reduced-motion: reduce)").matches,
    "an earlier story file left prefers-reduced-motion emulated; restore it in onTestFinished",
  ).toBe(false);
});
