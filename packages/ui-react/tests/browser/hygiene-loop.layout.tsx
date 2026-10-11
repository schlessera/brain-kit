/// <reference types="@vitest/browser-playwright" />
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
for (const width of [320, 1280]) {
  test(`Odysseus ${width}: browser → server → real CLI hygiene review and invalidation`, async () => {
    expect(await commands.hygieneLoop({ width })).toMatchObject({ width, fixed: 3, dismissed: 2, snoozed: 1, recoveryWrites: 1, invalidation: ["tokens"] });
  }, 120000);
}
