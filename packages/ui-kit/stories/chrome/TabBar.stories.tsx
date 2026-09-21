import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { TabBar, type TabBarProps, type TabItem } from "../../src/chrome/TabBar.js";
import { stage } from "../_stage.js";

const ITEMS: TabItem[] = [
  { icon: "brain", label: "Chat" },
  { icon: "resolved", label: "Actions", badge: "6" },
  { icon: "files", label: "Files" },
  { icon: "graph", label: "Graph" },
  { icon: "more", label: "More" },
];

const wired = () => ITEMS.map((it) => ({ ...it, onClick: fn() }));

/**
 * A FIXED width, not the stage's.
 *
 * `stageWidth` is a `max-width` on a `width: 100%` box, and under the preview's
 * `layout: "centered"` the story root shrink-wraps — so a component that does
 * not force a width renders at its CONTENT width and the cap never binds. For
 * most components that is harmless. For this one it is the whole subject: a tab
 * bar at content width has its five items touching, and touching items' 14px
 * padding boxes overlap by 28px, which is exactly the click theft the gap rule
 * exists to prevent.
 *
 * So every measurement story here states the width it is measuring at, rather
 * than inheriting whatever the harness happens to give it. 390 is the design's
 * own phone width.
 */
function bar(width: number) {
  return function render(args: TabBarProps) {
    return (
      <div style={{ width, boxSizing: "border-box" }}>
        <TabBar {...args} />
      </div>
    );
  };
}

const meta = preview.meta({
  title: "Chrome/TabBar",
  component: TabBar,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: { items: wired(), active: 1 },
  argTypes: { active: { control: { type: "range", min: 0, max: 4, step: 1 } } },
  render: bar(390),
});

/** Five slots, one amber. Actions owns its own slot because "decide this" and
 * "something broke" must never share a badge. */
export const Default = meta.story({});

export const ChatActive = Default.extend({ args: { active: 0 } });

export const NoBadge = Default.extend({
  args: { items: ITEMS.map((it) => ({ ...it, badge: undefined, onClick: fn() })) },
});

/** Four slots. The bar spaces whatever it is given rather than assuming five. */
export const FourSlots = Default.extend({
  args: { items: ITEMS.slice(0, 4).map((it) => ({ ...it, onClick: fn() })), active: 2 },
});

/**
 * **The hit target, MEASURED.** `padding: 9px 14px` with `margin: -9px -14px`
 * grows each item's border box by 18px vertically and 28px horizontally while
 * leaving its margin box — and therefore the layout — untouched.
 *
 * This is the design's SECOND sanctioned expansion method, and unlike the
 * pseudo-element one it has no off-by-one. Wave 3 found `inset: -9px` on a
 * bordered element short by 1px per side, because `inset` resolves against the
 * containing block's PADDING box and the border eats the difference. Padding is
 * not measured against anything — it IS the box — so the growth is exact. Both
 * numbers below are asserted rather than described.
 */
export const HitTargetIsExact = meta.story({
  play: async ({ canvas }) => {
    const tabs = await canvas.findAllByRole("tab");
    for (const tab of tabs) {
      const box = tab.getBoundingClientRect();
      const cs = getComputedStyle(tab);
      await expect(cs.paddingTop).toBe("9px");
      await expect(cs.paddingLeft).toBe("14px");
      await expect(cs.marginTop).toBe("-9px");
      await expect(cs.marginLeft).toBe("-14px");

      // The design's README predicts "~33px tall visual -> 51px hit". The
      // visual is the icon (20) + gap (3) + the label's line box, so the claim
      // worth asserting is the EXPANSION, which is exactly 18 and 28.
      const inner = { h: box.height - 18, w: box.width - 28 };
      await expect(box.height - inner.h).toBe(18);
      await expect(box.width - inner.w).toBe(28);
      // And the README's 51 is the real number at this width, within a pixel
      // of font metrics.
      await expect(box.height > 50 && box.height < 52).toBe(true);
    }

    // The expansion overlaps nothing at phone width: a probe one pixel inside
    // each item's own left and right edges belongs to that item.
    for (const tab of tabs) {
      const box = tab.getBoundingClientRect();
      for (const [side, x] of [
        ["left", box.left + 1],
        ["right", box.right - 1],
      ] as const) {
        const owner = document.elementFromPoint(x, box.top + box.height / 2)?.closest('[role="tab"]');
        await expect(`${tab.textContent} ${side} -> ${owner === tab ? "self" : "STOLEN"}`).toBe(
          `${tab.textContent} ${side} -> self`,
        );
      }
    }
  },
});

/**
 * The clear gap between two items' VISUALS, measured. The constraint is the
 * design's own: expansion per side must be no more than half the distance to
 * the nearest interactive neighbour, so 14px each side needs 28px of clear
 * space.
 *
 * At 390px it is 50.98px, because `space-around` hands each of the five slots
 * `(390 - 135) / 5` of margin. The same arithmetic says the gap reaches 28px at
 * a bar width of 276px, which is measured: 275px touches, 276px separates.
 */
export const NeighbourGapIsWideEnough = meta.story({
  play: async ({ canvas }) => {
    const tabs = await canvas.findAllByRole("tab");
    const gaps: number[] = [];
    for (let i = 1; i < tabs.length; i += 1) {
      const a = tabs[i - 1].getBoundingClientRect();
      const b = tabs[i].getBoundingClientRect();
      // Border boxes are the expanded ones; the VISUALS are 14px inside each.
      gaps.push(b.left + 14 - (a.right - 14));
    }
    for (const gap of gaps) await expect(gap >= 28).toBe(true);
  },
});

/**
 * And here is what happens below 276px. The later sibling's padding sits on top
 * of the earlier one's label and wins the hit test — the `FeedbackRow` bug, in a
 * tab bar. At 240px the two expanded boxes overlap by 7px.
 *
 * This asserts the THEFT rather than its absence, so a future change that fixes
 * the geometry fails this story and has to delete it on purpose.
 */
export const NarrowBarStealsTheClick = meta.story({
  render: bar(240),
  play: async ({ canvas }) => {
    const tabs = await canvas.findAllByRole("tab");
    const first = tabs[0].getBoundingClientRect();
    const owner = document.elementFromPoint(first.right - 1, first.top + first.height / 2)?.closest('[role="tab"]');
    await expect(owner).toBe(tabs[1]);
  },
});

/** A tap selects, and so does Enter. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tabs[3]);
    await expect(args.items?.[3].onClick).toHaveBeenCalled();
  },
});

/**
 * ←→ moves between slots and wraps. Activation does NOT follow focus here, which
 * is the opposite of `FilterRow`: arrowing through filters is filtering, but
 * arrowing through a tab bar would navigate away from the screen you are on.
 */
export const ArrowKeys = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const tabs = await canvas.findAllByRole("tab");
    tabs[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(document.activeElement).toBe(tabs[1]);
    await expect(args.items?.[1].onClick).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    // Home / End land on the edges without activating either.
    await userEvent.keyboard("{Home}");
    await expect(document.activeElement).toBe(tabs[0]);
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    await expect(args.items?.[0].onClick).not.toHaveBeenCalled();
  },
});

/** The hover moves the FOREGROUND only — there is no row to shade under a tab
 * bar — which is what `.bk-row-fg` is for, and the ring is drawn INSIDE at -2
 * because a tab sits against the frame's edge. */
export const RowClasses = meta.story({
  play: async ({ canvas }) => {
    const tabs = await canvas.findAllByRole("tab");
    for (const tab of tabs) {
      await expect(tab.className).toBe("bk-row bk-row-fg");
      await expect(tab.style.getPropertyValue("--hv-fg")).not.toBe("");
      await expect(tab.style.getPropertyValue("--hv-bg")).toBe("");
    }
  },
});

/**
 * THE CONTRACT. A bar whose slots carry no callbacks has no tablist, no roles
 * and no tab stops — it is a picture of a tab bar.
 *
 * Note what it DOES keep: the padding. That is the one place this component
 * departs from the kit's gating rule, because the padding is also the badge's
 * containing block and gating it would move the badge. `MixedGating` is where
 * the consequence is visible.
 */
export const Static = meta.story({
  args: { items: ITEMS },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("tablist")).toBeNull();
    await expect(canvas.queryByRole("tab")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
  },
});

/** Gating is per item. One wired slot among static ones still gets its role and
 * its tab stop, and the bar still gets its tablist. */
export const MixedGating = meta.story({
  args: { items: [{ ...ITEMS[0], onClick: fn() }, ITEMS[1], ITEMS[2]] },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("tablist")).toBeTruthy();
    await expect(await canvas.findAllByRole("tab")).toHaveLength(1);
  },
});

/**
 * ONE TAB STOP, NOT FIVE.
 *
 * The bar is a `tablist`, and a `tablist` is a single stop in the page's tab
 * order with the arrow keys moving inside it. Until this landed every slot was
 * `tabIndex={0}`, so a screen carrying this and a `SideRail` cost **ten tab
 * presses before any content** and the ←→ keys were redundant with Tab rather
 * than being the way you move (`docs/decisions/design-feedback.md` §11).
 *
 * The stop is the ACTIVE slot, so tabbing in puts you where you already are.
 */
export const OneTabStop = meta.story({
  play: async ({ canvas, canvasElement, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs).toHaveLength(5);
    await expect(canvasElement.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    await expect(tabs[1]).toHaveAttribute("tabindex", "0");
    for (const i of [0, 2, 3, 4]) await expect(tabs[i]).toHaveAttribute("tabindex", "-1");

    // Tab in lands on the active slot; Tab again leaves the bar entirely.
    await userEvent.tab();
    await expect(document.activeElement).toBe(tabs[1]);
    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(false);
  },
});

/**
 * The stop FOLLOWS THE CARET, which is the half of the pattern that is easy to
 * miss: after arrowing to Files, leaving and coming back returns you to Files
 * rather than to the active slot. Without it the arrow keys move focus and then
 * the next Tab silently undoes them.
 */
export const TheStopFollowsTheCaret = meta.story({
  play: async ({ canvas, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    tabs[1].focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect(document.activeElement).toBe(tabs[3]);
    await expect(tabs[3]).toHaveAttribute("tabindex", "0");
    await expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  },
});

/**
 * THE HAZARD, and why the stop is not simply the active slot.
 *
 * A group whose items are all `tabIndex={-1}` is not harder to reach, it is
 * unreachable — and that is exactly what "the active item is the stop" gives
 * you the moment the active item has no handler. Here slot 1 is the amber one
 * and carries no callback, so the stop falls to the first slot that does.
 */
export const AnUnreachableActiveSlotDoesNotStrandTheBar = meta.story({
  args: { items: [ITEMS[0], { ...ITEMS[1] }, { ...ITEMS[2], onClick: fn() }], active: 1 },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs).toHaveLength(1);
    await expect(tabs[0]).toHaveAttribute("tabindex", "0");
    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(true);
  },
});
