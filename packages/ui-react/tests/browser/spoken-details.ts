/// <reference types="@vitest/browser-playwright" />
// A spoken turn's details are reached through its hidden Details stop
// (#3728, #3700): there is no glyph to click at rest. These open it the
// ways a reader does.
import { expect } from "vitest";
import { userEvent } from "vitest/browser";

/** Hover the turn until the pill shows, then click the pill. */
export async function pointDetails(trigger: HTMLButtonElement) {
  const turn = trigger.closest<HTMLElement>(".bk-spoken-turn");
  expect(turn, "the Details stop belongs to a spoken turn").not.toBeNull();
  await userEvent.hover(turn!.firstElementChild!);
  await expect.poll(() => turn!.dataset.reveal, { message: "hovering the turn shows the pill" }).toBe("true");
  await userEvent.click(trigger);
}
