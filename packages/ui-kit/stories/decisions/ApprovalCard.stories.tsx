import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { approval } from "../../fixtures/actions.js";
import { ApprovalCard } from "../../src/decisions/ApprovalCard.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Decisions/ApprovalCard",
  component: ApprovalCard,
  decorators: [stage],
  args: {
    tool: approval.tool,
    target: approval.target,
    toolIcon: approval.toolIcon,
    badge: approval.badge,
    diff: approval.diff,
    risk: approval.risk,
    allowLabel: approval.allowLabel,
    denyLabel: approval.denyLabel,
    allowEffect: approval.allowEffect,
    onAllow: fn(),
    onDeny: fn(),
  },
  argTypes: { toolIcon: { control: "text" } },
});

/**
 * The real tool, the real target, the real diff, and the blast radius in plain
 * words. **Never use this for anything that is not actually blocking** — a card
 * that asks for permission it does not need teaches people to tap through the
 * ones that matter.
 *
 * The shell is `Surface`'s `bold` emphasis in amber, to the value, because
 * "needs a decision" is one thing in this kit and not two.
 */
export const Default = meta.story({});

/** No diff: a fetch that reads rather than writes still names its target and
 * still states what it reaches. */
export const NoDiff = Default.extend({ args: { diff: "" } });

/** No risk line, for an action whose blast radius is the diff itself. */
export const NoRisk = Default.extend({ args: { risk: "" } });

/** A long target ellipsises rather than pushing the badge off the card. */
export const LongTarget = Default.extend({
  args: { target: "winds.example.invalid/seventeen-days?from=ogygia&bearing=east-north-east" },
});

export const Wide = Default.extend({ parameters: wide });

/**
 * The effect chip is not decoration. The design's non-negotiable rule: a
 * control that writes exposes its effect as part of its accessible name —
 * "Fetch once, enqueue" — so a screen reader user hears what the tap does
 * rather than only what it is called.
 */
export const EffectIsAnnounced = meta.story({
  play: async ({ canvas }) => {
    const allow = await canvas.findByRole("button", { name: /Fetch once/ });
    await expect(allow).toHaveAccessibleName(`${approval.allowLabel} ${approval.allowEffect}`);
  },
});

/** Both buttons reach their own callback, and neither reaches the other's. */
export const Decided = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText(approval.allowLabel));
    await expect(args.onAllow).toHaveBeenCalledTimes(1);
    await expect(args.onDeny).not.toHaveBeenCalled();

    await userEvent.click(await canvas.findByText(approval.denyLabel));
    await expect(args.onDeny).toHaveBeenCalledTimes(1);
    await expect(args.onAllow).toHaveBeenCalledTimes(1);
  },
});

/**
 * THE BUG THIS CARD SHIPPED WITH, now a test.
 *
 * `Button` defaults to `block`, which is `width: 100%` and `flex: none` — full
 * width, and refuses to shrink. Two of them in a flex row each demand the whole
 * row and neither yields, so the row comes out 200% wide and "Deny" renders
 * outside the card. It typechecked, it passed every unit test, and the DC
 * parity harness called it identical, because the harness compares computed
 * style per node and never asks whether a node fits inside its parent.
 *
 * `hint-size` is a red herring — it is dead on a settled render. The real cause
 * is the `sc-host` decision: under DC the flex items were the wrapper divs, so
 * each Button's `width: 100%` resolved against a shrink-to-fit box and measured
 * 155px and 65px. Dropping the wrapper made that declaration live.
 *
 * The fix is the `style` prop wave 1 set aside for exactly this: both buttons
 * take `flex: 1 1 0`, so they split the row evenly, which is what 50%/50% meant.
 */
export const ButtonsFitTheCard = meta.story({
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("div > div") as HTMLElement;
    await expect(overflowing(card)).toEqual([]);

    // And the split is even, which is the other half of what the hints said.
    const [allow, deny] = [...card.querySelectorAll<HTMLElement>('[role="button"]')];
    const a = allow.getBoundingClientRect();
    const d = deny.getBoundingClientRect();
    await expect(Math.abs(a.width - d.width)).toBeLessThan(1.5);
  },
});

/** THE CONTRACT, delegated to `Button`. With no callbacks the card still
 * renders, and neither button is focusable or pressable. */
export const Static = meta.story({
  args: { onAllow: undefined, onDeny: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});
