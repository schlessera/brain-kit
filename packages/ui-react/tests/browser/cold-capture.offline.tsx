/// <reference types="@vitest/browser-playwright" />
import { commands } from "vitest/browser";
import { expect, test } from "vitest";
import type {} from "./offline/cold-capture/commands.js";
for (const width of [320, 390, 900, 1280]) for (const theme of ["dark", "light"] as const) for (const pointer of ["fine", "coarse"] as const) {
  test(`cached cold capture at ${width}px ${theme} ${pointer}`, async () => {
    expect(await commands.coldCapture({ scenario: "cold", width, theme, pointer })).toContain("passed");
  }, 45_000);
}
for (const scenario of ["reauth", "unsupported", "uncontrolled", "uncached", "continue-recording", "dispose", "gap"] as const) test(`${scenario} local-capture boundary`, async () => {
  expect(await commands.coldCapture({ scenario, width: 390, theme: "dark", pointer: "fine" })).toContain("passed");
}, 45_000);
