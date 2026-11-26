import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { StorageMapLegend, type StorageMapLegendOwner } from "../../src/storage/StorageMapLegend.js";
import { viewportAt } from "../_viewports.js";
import { Frame, storageViewport } from "./_storage.js";

const owners: StorageMapLegendOwner[] = [
  { owner: "brain", total: "4.80 GB" },
  { owner: "app", total: "24.3 GB" },
  { owner: "operator", total: "3.00 GB" },
];

const meta = preview.meta({
  title: "Storage/StorageMapLegend",
  component: StorageMapLegend,
  parameters: { layout: "fullscreen" },
  beforeEach: storageViewport,
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: { owners },
  globals: viewportAt(320),
});

/** Every store measured: three owner chips and no unknown chip. Chips are text, not filters. */
export const Measured = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-legend-owner]")).toHaveLength(3);
    await expect(canvasElement.querySelector("[data-legend-unknown]")).toBeNull();
    await expect(canvasElement.querySelector("button"), "chips are not filters").toBeNull();
    for (const owner of ["brain", "app", "operator"])
      await expect(canvasElement.querySelector(`[data-legend-owner="${owner}"] svg[data-edge]`)?.getAttribute("data-edge")).toBe(
        { brain: "solid", app: "dotted", operator: "dashed" }[owner],
      );
  },
});
export const MeasuredDesktop = Measured.extend({ globals: viewportAt(1280) });

/** Two stores unmeasured: `? 2 stores · size unknown · not drawn`. */
export const WithUnknown = meta.story({
  args: { unknownCount: 2 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-legend-unknown]")?.textContent).toBe("?2 stores · size unknown · not drawn");
  },
});
export const WithUnknownDesktop = WithUnknown.extend({ globals: viewportAt(1280) });

/** One store, singular; with a jump target the chip is a 44px button to the first `?` row. */
export const JumpToUnknown = meta.story({
  args: { unknownCount: 1, onShowUnknown: fn() },
  play: async ({ canvas, args, userEvent }) => {
    const jump = await canvas.findByRole("button", { name: "1 store · size unknown · not drawn. Show in list" });
    await expect(jump.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(jump);
    await expect(args.onShowUnknown).toHaveBeenCalledTimes(1);
  },
});

/** A view with only App stores prints only the App chip. */
export const OneOwner = meta.story({ args: { owners: [{ owner: "app", total: "68.3 MB" }] } });
