import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { queueFilters } from "../../fixtures/actions.js";
import { fileFilters } from "../../fixtures/files.js";
import { searchTabs } from "../../fixtures/search.js";
import { FilterRow } from "../../src/rows/FilterRow.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Rows/FilterRow",
  component: FilterRow,
  decorators: [stage],
  args: {
    items: queueFilters.map((label) => ({ label, onClick: fn() })),
    active: 0,
    mono: true,
  },
  argTypes: { active: { control: { type: "number", min: 0, max: 6, step: 1 } } },
});

/** Counts live inside the label ("ready 3") rather than in a separate badge, so
 * the row stays one line however many filters there are. */
export const Default = meta.story({});

export const SecondSelected = Default.extend({ args: { active: 1 } });

export const Proportional = Default.extend({
  args: { mono: false, items: fileFilters.map((f) => ({ label: f.label, onClick: fn() })) },
});

/** The search result set's three views. The graph is a view, not a destination,
 * which is why it is a filter pill rather than a screen. */
export const SearchViews = Default.extend({
  args: { items: searchTabs.map((t) => ({ label: t.label, onClick: fn() })), mono: false },
});

export const Wide = Default.extend({ parameters: wide });

/** A tap selects, and so does Enter. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    await userEvent.click(tabs[1]);
    await expect(args.items?.[1].onClick).toHaveBeenCalled();
  },
});

/**
 * ←→ moves between pills and wraps, per the design's key table. Activation
 * FOLLOWS FOCUS here — arrowing through filters is filtering — which is the
 * automatic-activation pattern and the reason each arrow key also fires the
 * pill's own callback.
 */
export const ArrowKeys = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const tabs = await canvas.findAllByRole("tab");
    tabs[0].focus();

    await userEvent.keyboard("{ArrowRight}");
    await expect(document.activeElement).toBe(tabs[1]);
    await expect(args.items?.[1].onClick).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{ArrowLeft}");
    await expect(document.activeElement).toBe(tabs[0]);
    await expect(args.items?.[0].onClick).toHaveBeenCalledTimes(1);

    // Wraps rather than stopping at the end.
    await userEvent.keyboard("{ArrowLeft}");
    await expect(document.activeElement).toBe(tabs[tabs.length - 1]);
  },
});

/** The row is a `tablist`, because a `tab` outside one announces neither the
 * set nor the position in it. The source leaves the container role off; this is
 * the port finishing the job rather than redesigning it. */
export const Tablist = meta.story({
  play: async ({ canvas }) => {
    const list = await canvas.findByRole("tablist");
    await expect(list.querySelectorAll('[role="tab"]')).toHaveLength(4);
  },
});

/**
 * THE CONTRACT, and here it is PER ITEM. A row whose pills carry no callbacks
 * has no tablist, no roles and no tab stops — it is a legend, not a filter.
 */
export const Static = meta.story({
  args: { items: queueFilters.map((label) => ({ label })) },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("tablist")).toBeNull();
    await expect(canvas.queryByRole("tab")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

/** One interactive pill among static ones still gets its role and tab stop, and
 * the row still gets its tablist. Gating is per item, not per row. */
export const MixedGating = meta.story({
  args: {
    items: [{ label: "all 9", onClick: fn() }, { label: "ready 3" }, { label: "blocked 1" }],
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("tablist")).toBeTruthy();
    await expect(await canvas.findAllByRole("tab")).toHaveLength(1);
  },
});
