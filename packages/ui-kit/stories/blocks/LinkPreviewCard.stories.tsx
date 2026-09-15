import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { linkPreview } from "../../fixtures/files.js";
import { LinkPreviewCard } from "../../src/blocks/LinkPreviewCard.js";
import { ROW_RING, ring, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/LinkPreviewCard",
  component: LinkPreviewCard,
  decorators: [stage],
  args: { ...linkPreview, onClick: fn() },
});

/**
 * Something that arrived from outside the corpus. The hatched thumb is
 * deliberate — Brain does not render remote images inline — and the purple
 * provenance line is what makes the card's own border purple, so a monochrome
 * screenshot still says "untrusted".
 */
export const Default = meta.story({});

/** No provenance line: the card falls back to the plain card edge, because
 * there is nothing to warn about. */
export const Trusted = Default.extend({ args: { trust: "" } });

/** A long title over two lines, for a headline the single line would eat. */
export const Unclamped = Default.extend({
  args: { clamp: false, title: "What the hall is saying about the succession, and who is saying it" },
});

export const Wide = Default.extend({ parameters: wide });

/** The card is one target and opening it is navigation, never an effect. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    // Click the title, so the assertion is that the handler is on the CARD and
    // the event reaches it from inside — querying a bare `div > div` finds the
    // stage decorator, and clicking a parent never reaches its child.
    await userEvent.click(await canvas.findByText(/succession/));
    await expect(args.onClick).toHaveBeenCalled();
  },
});

/**
 * THE CONTRACT, wave 1b. Opening a preview is navigation, so the whole card is
 * one `role="button"` — one target, one name, no effect chip — and it takes
 * `.bk-row` rather than `.bk-control` because a ring at +2 on a full-width card
 * is drawn outside the first `overflow: hidden` ancestor and clipped away.
 *
 * The accessible name is the card's own contents, which is what a card that is
 * a single target should sound like: title, meta and provenance read as one
 * thing rather than as three.
 */
export const Operable = meta.story({
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const card = await canvas.findByRole("button");
    await expect(card).toHaveAttribute("tabindex", "0");
    await expect(card.className).toBe("bk-row");

    // Reached by Tab, and ringed once it is there. The ring is drawn INSIDE:
    // a +2 offset on a full-width card is clipped by the first overflow:hidden
    // ancestor, which in this kit is every Surface.
    await userEvent.tab();
    await expect(document.activeElement).toBe(card);
    await expect(ring(card)).toEqual(ROW_RING);

    // Keyboard activation is part of porting a role: both keys, as the design's
    // own table says, and a role that only answers the mouse is worse than none.
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);

    // Hover has somewhere to go, and it is a colour rather than a reset.
    await expect(canvasElement.querySelector<HTMLElement>(".bk-row")!.style.getPropertyValue("--hv-bg")).toBe(
      "var(--bk-color-raised)",
    );
  },
});

/** THE GATE. No handler, no class, no role, no tab stop — a static preview does
 * not pretend to be openable. */
export const Static = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row, .bk-control")).toBeNull();
  },
});
