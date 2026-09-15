import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { feedbackQuestion } from "../../fixtures/search.js";
import { FeedbackRow } from "../../src/blocks/FeedbackRow.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/FeedbackRow",
  component: FeedbackRow,
  decorators: [stage],
  args: { question: feedbackQuestion, onUp: fn(), onDown: fn() },
});

/**
 * "Was this right?" — asked about a specific act, never about the app. A thumb
 * here is training signal, which is why the question names what it is judging.
 */
export const Default = meta.story({});

export const VotedUp = Default.extend({ args: { value: "up" } });
export const VotedDown = Default.extend({ args: { value: "down" } });

/** No callbacks: no roles, no tab stops, no expanded targets. A feedback row
 * nobody is listening to does not pretend to take a vote. */
export const Static = meta.story({
  args: { onUp: undefined, onDown: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-thumb")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector("[aria-pressed]")).toBeNull();
  },
});

export const Wide = Default.extend({ parameters: wide });

/** A tap records, and so do Enter and Space. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const [up, down] = await canvas.findAllByRole("button");
    await expect(up).toHaveAttribute("aria-label", "Yes, that was right");
    await expect(up).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(up);
    await expect(args.onUp).toHaveBeenCalledTimes(1);

    down.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.onDown).toHaveBeenCalledTimes(2);
  },
});

/**
 * THE BUG THIS COMPONENT IS NAMED FOR, and a measurement that corrects the
 * design's own note about it.
 *
 * Each thumb is drawn 30x26 and extends its target with a transparent
 * pseudo-element at `inset: -9px`. The source's comment calls the result
 * "48x44" — 30+18 by 26+18 — and **that is 2px generous on both axes.** An
 * absolutely positioned pseudo-element is offset from its containing block's
 * PADDING box, not its border box, so a 1px border eats 1px of the expansion
 * on every side: the real target is **46x42**.
 *
 * Measured here rather than argued, and it matters: 42 is under the design's
 * own 44px floor for a touch target. Reported rather than fixed, because
 * fixing it is a design change with a second edge — `inset: -10px` would give
 * a true 48x44 but would then demand `gap >= 20`, and the design's gap is 18,
 * so the two thumbs' targets would start overlapping and the bug below would
 * come back. Both numbers have to move together, and that is the design's
 * call. See `.plan/PLAN.md`'s wave 3 notes.
 *
 * The constraint that still holds: expansion per side (8px past the paint)
 * must be no more than half the distance to the nearest interactive neighbour,
 * and 8 + 8 = 16 fits inside `gap: 18` with 2px to spare.
 *
 * Probes are at the EDGES, one pixel inside, because centres always pass and
 * edges are where this fails. The wrapper's padding is not decoration: an
 * expanded target near a container edge reaches outside it, and
 * `elementFromPoint` off the viewport returns `null`.
 */
export const HitTargets = meta.story({
  render: (args) => (
    <div style={{ padding: 20 }}>
      <FeedbackRow {...args} />
    </div>
  ),
  play: async ({ canvas }) => {
    const [up, down] = await canvas.findAllByRole("button");

    // `inset: -9px` from the padding box, less the 1px border, is 8px past the
    // paint on each side. This is the number the probes use, and it is the one
    // the assertion below measures rather than assumes.
    const REACH = 8;

    for (const [name, el] of [
      ["up", up],
      ["down", down],
    ] as const) {
      const box = el.getBoundingClientRect();
      // One pixel inside each edge of the real target, so a probe lands on the
      // hit area rather than exactly on its boundary — where hit testing is
      // ambiguous and a corner probe reads as outside.
      const left = box.left - REACH + 1;
      const right = box.right + REACH - 1;
      const top = box.top - REACH + 1;
      const bottom = box.bottom + REACH - 1;

      const probes: [string, number, number][] = [
        ["top-left", left, top],
        ["top-right", right, top],
        ["bottom-left", left, bottom],
        ["bottom-right", right, bottom],
        ["left-centre", left, (top + bottom) / 2],
        ["right-centre", right, (top + bottom) / 2],
      ];

      for (const [corner, x, y] of probes) {
        const owner = document.elementFromPoint(x, y)?.closest('[role="button"]');
        await expect(`${name} ${corner} -> ${owner === el ? "self" : "STOLEN"}`).toBe(
          `${name} ${corner} -> self`,
        );
      }
    }

    // The expansion stops where it stops: 10px above the paint is outside the
    // 8px reach and belongs to nothing.
    const box = up.getBoundingClientRect();
    const outside = document.elementFromPoint(box.left + box.width / 2, box.top - 10);
    await expect(outside?.closest('[role="button"]')).toBeNull();

    // And the measurement itself, stated as a number so a change to the inset
    // or the border has to come past this line. 30x26 drawn; 46x42 hit.
    await expect(`${box.width}x${box.height}`).toBe("30x26");
    await expect(`${box.width + 2 * REACH}x${box.height + 2 * REACH}`).toBe("46x42");
  },
});

/**
 * PROOF THE ASSERTION ABOVE HAS TEETH, and a reproduction of the real bug.
 *
 * The same probe at `gap: 10` — below the 18px the 9px inset requires. The
 * DOWN thumb is the later sibling, so its invisible target sits on top of the
 * UP thumb's right-hand edge and wins the hit test: a user aiming at the right
 * of thumbs-up records thumbs-DOWN. The design records this happening for
 * real, and this story is the standing regression test for it.
 *
 * It asserts the theft rather than the absence of it, so a future change that
 * fixes the geometry fails here and has to delete the story deliberately.
 */
export const NarrowGapStealsTheClick = meta.story({
  args: { gap: 10 },
  render: (args) => (
    <div style={{ padding: 20 }}>
      <FeedbackRow {...args} />
    </div>
  ),
  play: async ({ canvas }) => {
    const [up, down] = await canvas.findAllByRole("button");
    const box = up.getBoundingClientRect();

    // One pixel inside the UP thumb's own expanded right edge.
    const owner = document
      .elementFromPoint(box.right + 9 - 1, (box.top + box.bottom) / 2)
      ?.closest('[role="button"]');

    await expect(owner === down ? "STOLEN by the later sibling" : "self").toBe(
      "STOLEN by the later sibling",
    );
  },
});
