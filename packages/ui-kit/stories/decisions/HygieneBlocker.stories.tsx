import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";
import { HygieneBlocker } from "../../src/decisions/HygieneCard.js";
import { overflowing, stage } from "../_stage.js";
const meta = preview.meta({
  title: "Decisions/HygieneBlocker",
  component: HygieneBlocker,
  decorators: [stage],
  args: { reason: 'unknown key "schemaa" (line 3)', onOpen: fn(), onRetry: fn() },
});
/** Both actions sit together under the callout, start-aligned and content-sized. */
export const Configuration = meta.story({
  play: async ({ canvas, canvasElement }) => {
    const column = canvasElement.querySelector<HTMLElement>("[data-hygiene-blocker]")!.getBoundingClientRect();
    const open = canvas.getByRole("button", { name: "Open configuration ›" }).getBoundingClientRect();
    const again = canvas.getByRole("button", { name: "Start again" }).getBoundingClientRect();
    await expect(Math.round(open.left), "actions start at the column's edge").toBe(Math.round(column.left));
    await expect(Math.round(again.top), "the two actions share a row").toBe(Math.round(open.top));
    for (const action of [open, again]) {
      await expect(action.width, "an action is content-sized, not stretched").toBeLessThan(column.width / 2);
      await expect(action.height).toBeGreaterThanOrEqual(44);
    }
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});
