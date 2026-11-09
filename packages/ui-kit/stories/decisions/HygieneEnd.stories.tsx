import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";
import { HygieneEnd } from "../../src/decisions/HygieneCard.js";
import { stage } from "../_stage.js";
const click = fn();
const meta = preview.meta({
  title: "Decisions/HygieneEnd",
  component: HygieneEnd,
  decorators: [stage],
  args: {
    empty: false,
    fixed: 4,
    dismissed: 1,
    snoozed: 2,
    due: "13 Jul",
    informational: 3,
    dismissedErrors: 1,
    onShowSnoozed: click,
  },
});
/** "Show snoozed" is content-sized and centred under the centred summary. */
export const Complete = meta.story({
  play: async ({ canvas, canvasElement }) => {
    const column = canvasElement.querySelector<HTMLElement>("[data-hygiene-end]")!.getBoundingClientRect();
    const show = canvas.getByRole("button", { name: "Show snoozed (2)" }).getBoundingClientRect();
    await expect(show.width, "the action is content-sized, not stretched").toBeLessThan(column.width / 2);
    const centre = (r: DOMRect) => r.left + r.width / 2;
    await expect(Math.abs(centre(show) - centre(column)), "the action is centred").toBeLessThanOrEqual(1);
  },
});
export const NoOpenFindings = meta.story({ args: { empty: true, fixed: 0 } });
