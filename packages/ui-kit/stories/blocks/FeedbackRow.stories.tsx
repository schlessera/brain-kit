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
 * THE BUG THIS COMPONENT IS NAMED FOR, and the measurement that fixed it.
 *
 * Each thumb is drawn 30x26 and extends its target with a transparent
 * pseudo-element at `inset: -9px -8px`: **46x44**, and that number is exact
 * because the thumb's hairline is an inset box-shadow rather than a border.
 * For three waves it was a border, and the target measured 46x42 — an
 * absolutely positioned pseudo-element is offset from its containing block's
 * PADDING box, so a 1px border eats 1px of reach per side — which put it 2px
 * under the design's own 44px floor. Design-feedback §1 asked the design to
 * choose; the 2026-09-18 drop chose the borderless element and stated the
 * per-axis rule, and this story now asserts the real reach.
 *
 * The constraint that holds: expansion per side must be no more than half the
 * distance to the nearest interactive neighbour ON THAT AXIS. Only the
 * horizontal has one, so it reaches 8px against `gap: 18` with 2px to spare,
 * and the vertical reaches its full 9px.
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

    // `inset: -9px -8px` from a padding box that IS the paint — no border —
    // so the reach is 9 vertically and 8 horizontally, and the probes use both.
    const REACH = 8;
    const REACH_Y = 9;

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
      const top = box.top - REACH_Y + 1;
      const bottom = box.bottom + REACH_Y - 1;

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

    // The expansion stops where it stops: 11px above the paint is outside the
    // 9px reach and belongs to nothing.
    const box = up.getBoundingClientRect();
    const outside = document.elementFromPoint(box.left + box.width / 2, box.top - 11);
    await expect(outside?.closest('[role="button"]')).toBeNull();

    // And the measurement itself, stated as a number so a change to the inset
    // or a border creeping back has to come past this line. 30x26 drawn;
    // 46x44 hit — the floor, met.
    await expect(`${box.width}x${box.height}`).toBe("30x26");
    await expect(`${box.width + 2 * REACH}x${box.height + 2 * REACH_Y}`).toBe("46x44");
    // The hairline is a shadow, not a border: a border would make the two
    // lines above lie by 2px on each axis.
    await expect(getComputedStyle(up).borderTopWidth).toBe("0px");
    await expect(getComputedStyle(up).boxShadow).toContain("inset");
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
