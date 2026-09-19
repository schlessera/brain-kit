import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { toasts } from "../../fixtures/actions.js";
import { InlineToast } from "../../src/conversation/InlineToast.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/InlineToast",
  component: InlineToast,
  decorators: [stage],
  args: { ...toasts[0], onUndo: fn() },
});

/**
 * The receipt for a named effect. Every button in this kit declares what it
 * will run; this confirms it ran, in the same mono vocabulary and with the
 * same effect name. It stays in the transcript rather than floating away — a
 * receipt you can scroll back to.
 */
export const Default = meta.story({});

export const Queued = Default.extend({ args: { ...toasts[1], onUndo: fn() } });
export const Policy = Default.extend({ args: { ...toasts[2], onUndo: fn() } });

/** Still running: the card breathes and the glyph swaps to `later`. */
export const Pending = Default.extend({ args: { pending: true, text: "Filing" } });

/** A failure is red and held back to a 35% border over a 6% tint — a receipt
 * for a failure should not shout louder than the failure did. */
export const Failed = Default.extend({
  args: { tone: "red", text: "Failed", target: "wind forecast", effect: "web_fetch", undoLabel: "Retry" },
});

/** `undoLabel: ""` renders no undo. Reserved for an effect that genuinely
 * cannot be reversed — and by the design's own rule, one of those should never
 * have been a one-tap decision in the first place. */
export const NoUndo = Default.extend({ args: { undoLabel: "" } });

export const Wide = Default.extend({ parameters: wide });

/**
 * `aria-live="polite"` on the whole receipt is one of the design's five
 * non-negotiable rules. A toast appears without the user doing anything to
 * make it appear, so without it a screen-reader user learns nothing happened.
 */
export const ReceiptIsLive = meta.story({
  play: async ({ canvasElement }) => {
    const live = canvasElement.querySelector('[aria-live="polite"]');
    await expect(live).not.toBeNull();
    await expect(live!.textContent).toContain("Filed");
  },
});

export const Undone = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const undo = await canvas.findByRole("button");
    await userEvent.click(undo);
    undo.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onUndo).toHaveBeenCalledTimes(2);
  },
});

/**
 * Undo is text-sized and must be a 44px-tall target, so `.bk-undo::before`
 * reaches 16px above and below and 10px either side: **45.65 tall** from a
 * 13.65px line box. It is the only interactive thing in the toast, so it has
 * no neighbour to steal from — but it does reach past the toast's own 9px
 * padding, which is why two toasts must not be stacked flush against each
 * other.
 *
 * For three waves it measured 43.65 — 0.35px UNDER the floor — because the
 * underline was a `border-bottom`, and `inset` is resolved against the
 * containing block's PADDING box, so the border ate 1px of the downward reach
 * (design-feedback §1). The 2026-09-18 drop's answer: the underline is
 * `text-decoration`, which touches nothing in the box model, so the stated
 * reach is the real reach. This story asserts both the number and the reason.
 *
 * The wrapper's padding is there because an expanded target near a container
 * edge reaches outside it, and `elementFromPoint` off the viewport is `null`.
 */
export const UndoHitTarget = meta.story({
  render: (args) => (
    <div style={{ padding: 24, width: "100%" }}>
      <InlineToast {...args} />
    </div>
  ),
  play: async ({ canvas }) => {
    const undo = await canvas.findByRole("button");
    const box = undo.getBoundingClientRect();

    // 16 above the paint, 16 below, 10 either side — and the paint is the
    // padding box, because the underline is text-decoration, not a border.
    const UP = 16;
    const DOWN = 16;
    const SIDE = 10;

    // The drawn word is tiny; the target is over thirty pixels taller, and it
    // clears the 44px floor with the underline drawn.
    await expect(box.height).toBeLessThan(20);
    await expect(box.height + UP + DOWN).toBeGreaterThan(44);
    await expect(getComputedStyle(undo).borderBottomWidth).toBe("0px");
    await expect(getComputedStyle(undo).textDecorationLine).toBe("underline");

    for (const [name, x, y] of [
      ["top-left", box.left - SIDE + 1, box.top - UP + 1],
      ["bottom-right", box.right + SIDE - 1, box.bottom + DOWN - 1],
      ["top-centre", (box.left + box.right) / 2, box.top - UP + 1],
    ] as [string, number, number][]) {
      const owner = document.elementFromPoint(x, y)?.closest('[role="button"]');
      await expect(`${name} -> ${owner === undo ? "self" : "MISSED"}`).toBe(`${name} -> self`);
    }
  },
});

/** No callback: no role, no tab stop, no expanded target. A receipt with
 * nothing listening is a statement, not a control. */
export const Static = meta.story({
  args: { onUndo: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-undo")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

/**
 * A RECEIPT IS THE RECORD, so its target wraps rather than ellipsising —
 * unlike a row that opens something, where the full value is one click away.
 * Half a filename on a receipt is an unciteable receipt, so the long path here
 * has to be fully on screen: nothing clipped, nothing past the edge, and the
 * effect chip and Undo still beside it.
 */
export const LongTargetWraps = meta.story({
  args: {
    text: "Filed",
    target: "voyage/ithaca/omens/day-3651-eagle-over-the-hall-reported-by-the-swineherd-at-first-light.md",
    effect: "write_note",
  },
  play: async ({ canvas, canvasElement, args }) => {
    const toast = canvasElement.querySelector<HTMLElement>('[aria-live="polite"]')!;
    await expect(overflowing(toast)).toEqual([]);
    const text = canvas.getByText(args.target!).parentElement!;
    await expect(getComputedStyle(text).textOverflow).not.toBe("ellipsis");
    await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    // Wrapped, so the line box is taller than one line.
    await expect(text.getBoundingClientRect().height).toBeGreaterThan(20);
  },
});
