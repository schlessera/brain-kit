import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { DispositionBar } from "../../src/decisions/DispositionBar.js";
import { overflowing, stage } from "../_stage.js";

const meta = preview.meta({
  title: "Decisions/DispositionBar",
  component: DispositionBar,
  decorators: [stage],
  args: {
    commit: { label: "Approve", name: "Approve: Edit finances/ithaca-port.md", effect: "enqueue", onClick: fn() },
    later: { label: "Later", name: "Later: File the harbour-fee notice", onClick: fn() },
    dismiss: { label: "Dismiss", name: "Dismiss: File the harbour-fee notice", onClick: fn() },
  },
});

/** The commit takes the remaining width; Later and Dismiss keep a 96 x 44 floor. */
export const Approve = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const approve = await canvas.findByRole("button", { name: "Approve: Edit finances/ithaca-port.md" });
    await userEvent.click(approve);
    await expect(args.commit!.onClick).toHaveBeenCalledTimes(1);
    for (const name of [/^Later/, /^Dismiss/]) {
      const box = canvas.getByRole("button", { name }).getBoundingClientRect();
      await expect(box.width).toBeGreaterThanOrEqual(96);
      await expect(box.height).toBeGreaterThanOrEqual(44);
    }
  },
});

/** Choose's commit names the option it applies. */
export const Choose = meta.story({
  args: { commit: { label: "Apply: journeys/ogygia.md", name: "Apply: Edit journeys/ogygia.md", effect: "enqueue", onClick: fn() } },
});

/** While an answer is recorded, every control is inert and the tapped one says so. */
export const Applying = meta.story({
  args: { busy: "commit", busyLabel: "Recording…" },
  play: async ({ canvas, canvasElement, args }) => {
    await expect(canvas.getByText("Recording…")).toBeTruthy();
    await expect(canvasElement.querySelector("[aria-busy='true']")).not.toBeNull();
    for (const button of canvas.getAllByRole("button")) {
      await expect(button.getAttribute("aria-disabled")).toBe("true");
      // A pointer cannot reach it (pointer-events: none); a programmatic
      // click must not fire either.
      button.click();
    }
    await expect(args.commit!.onClick).not.toHaveBeenCalled();
    await expect(args.dismiss!.onClick).not.toHaveBeenCalled();
  },
});

/** A disabled bar says why, once, in words. */
export const Disabled = meta.story({
  args: {
    commit: { label: "Approve", name: "Approve", disabled: true, onClick: fn() },
    later: { label: "Later", disabled: true, onClick: fn() },
    dismiss: { label: "Dismiss", disabled: true, onClick: fn() },
    reason: "needs the host",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("needs the host")).toBeTruthy();
    for (const button of canvas.getAllByRole("button")) await expect(button.getAttribute("aria-disabled")).toBe("true");
  },
});

/** At 320px the row wraps rather than shrinking a control below its floor. */
export const Wrap320 = meta.story({
  parameters: { stageWidth: 320 },
  args: { commit: { label: "Review 48 lines to approve", name: "Review all 48 lines before approving", onClick: fn() } },
  play: async ({ canvasElement }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});
