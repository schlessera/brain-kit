import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { suggestions } from "../../fixtures/search.js";
import { SuggestionChips } from "../../src/conversation/SuggestionChips.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/SuggestionChips",
  component: SuggestionChips,
  decorators: [stage],
  args: { label: "Next", items: suggestions.slice(0, 3).map((s) => ({ ...s, onClick: fn() })) },
});

/**
 * Follow-ups offered after an answer. Every chip is a prompt the user could
 * have typed, in their voice — not a menu of app features. Three or four
 * maximum: past that it is a menu, and a menu is the app telling the user what
 * to want.
 */
export const Default = meta.story({});

/**
 * An UNTONED chip is transparent with the plain card edge. The presence of a
 * tone is what makes a chip toned, and `neutral` is the DIM INK ramp rather
 * than the neutral accent — which is why an explicitly-neutral chip reads as
 * text and an untoned one reads as an outline.
 */
export const TonePresenceMatters = Default.extend({
  args: {
    items: [
      { label: "What else is unfiled?", onClick: fn() },
      { label: "What else is unfiled?", onClick: fn() },
    ],
  },
});

/** A chip that carries an EFFECT is amber, because tapping it will write
 * something. The effect is the reason the tone exists at all. */
export const CarriesAnEffect = Default.extend({
  args: {
    items: [
      { label: "Draft the reply to the council", icon: "compose", tone: "amber", onClick: fn() },
      { label: "Show me the other landfalls", icon: "graph", onClick: fn() },
    ],
  },
});

export const NoLabel = Default.extend({ args: { label: "" } });

/** `wrap: false` keeps one line and clips. Worth seeing before choosing it. */
export const NoWrap = Default.extend({ args: { wrap: false } });

export const Wide = Default.extend({ parameters: wide });

/** A tap fires, and so do Enter and Space. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const chips = await canvas.findAllByRole("button");
    await userEvent.click(chips[0]);
    await expect(args.items?.[0].onClick).toHaveBeenCalledTimes(1);

    chips[1].focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.items?.[1].onClick).toHaveBeenCalledTimes(1);
  },
});

/**
 * GATING IS PER CHIP. The source sets `role` and `tabIndex` unconditionally;
 * wave 1 already settled that conflict on `Button` — the design's own handler
 * rule wins over the file that forgets it — so a chip with no callback is a
 * label, not a control.
 */
export const Static = meta.story({
  args: { items: suggestions.slice(0, 3).map((s) => ({ ...s })) },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

export const MixedGating = meta.story({
  args: {
    items: [{ label: "Ask this", onClick: fn() }, { label: "Just a label" }],
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findAllByRole("button")).toHaveLength(1);
  },
});

/**
 * COST IS PRINTED, NOT HOVERED (D52 §2). `cost` is the caller's own word, a
 * gold effect chip after the label; the kit never estimates one, and a chip
 * that cannot spend passes nothing.
 */
export const WithCost = meta.story({
  args: {
    label: "Start with",
    items: [
      { label: "What's new?", icon: "digest", tone: "amber", cost: "spends", onClick: fn() },
      { label: "Search…", icon: "search", onClick: fn() },
      { label: "Add a note…", icon: "add", onClick: fn() },
    ],
  },
  play: async ({ canvas }) => {
    const chip = canvas.getByRole("button", { name: /What's new\?/ });
    await expect(chip).toHaveTextContent("spends");
    await expect(canvas.getByRole("button", { name: "Search…" })).not.toHaveTextContent("spends");
  },
});

/**
 * UNAVAILABLE, WITH ITS REASON (D52 §2). The chip stays a tab stop and is
 * announced as disabled, keeps its cost, prints why after the label, and
 * ignores a click, Enter and Space.
 */
export const Disabled = meta.story({
  args: {
    label: "Start with",
    items: [
      { label: "What's new?", icon: "digest", tone: "amber", cost: "spends", disabled: true, why: "needs the host", onClick: fn() },
      { label: "Search…", icon: "search", onClick: fn() },
    ],
  },
  play: async ({ canvas, userEvent, args }) => {
    const chip = canvas.getByRole("button", { name: /What's new\?/ });
    await expect(chip).toHaveAttribute("aria-disabled", "true");
    await expect(chip).toHaveTextContent("spends");
    await expect(chip).toHaveTextContent("needs the host");
    await userEvent.click(chip);
    chip.focus();
    await expect(chip).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.items?.[0].onClick).not.toHaveBeenCalled();
    // The neighbour still works, so the rejection is the chip's, not the row's.
    await userEvent.click(canvas.getByRole("button", { name: "Search…" }));
    await expect(args.items?.[1].onClick).toHaveBeenCalledTimes(1);
  },
});

/** In a narrow column the reason wraps inside the chip rather than being clipped. */
export const DisabledNarrow = Disabled.extend({
  parameters: { stageWidth: 200 },
  args: {
    items: [
      { label: "What's new?", icon: "digest", tone: "amber", cost: "spends", disabled: true, why: "a turn is running", onClick: fn() },
    ],
  },
  play: async ({ canvas }) => {
    const chip = canvas.getByRole("button", { name: /What's new\?/ });
    await expect(chip.scrollWidth, "the reason is not clipped").toBeLessThanOrEqual(chip.clientWidth);
  },
});
