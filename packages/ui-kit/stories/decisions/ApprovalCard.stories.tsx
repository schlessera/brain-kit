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

/**
 * A long target WRAPS. The card IS the record — you are granting permission
 * against this exact string — so the README's truncation table lists it beside
 * the receipts: never truncate. A first-ever fetch cut at "…/seventeen…" is a
 * permission nobody can judge. The badge keeps its place and nothing escapes.
 */
export const LongTarget = Default.extend({
  args: { target: "winds.example.invalid/seventeen-days/from-ogygia/bearing-east-north-east/keep-the-great-bear-on-the-left-hand" },
  play: async ({ canvas, canvasElement, args }) => {
    const card = canvasElement.querySelector("div > div") as HTMLElement;
    const target = canvas.getByText(args.target!);
    await expect(overflowing(card)).toEqual([]);
    await expect(getComputedStyle(target).whiteSpace).toBe("normal");
    await expect(getComputedStyle(target).textOverflow).not.toBe("ellipsis");
    // Wrapped onto more than one line: taller than the tool name beside it.
    const tool = canvas.getByText(args.tool!);
    await expect(target.getBoundingClientRect().height).toBeGreaterThan(tool.getBoundingClientRect().height * 1.8);
    // And the full string is in the DOM, not a clipped one.
    await expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  },
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
 * The fix is the `style` prop wave 1 set aside for exactly this. The port first
 * split the row evenly; the seventh drop ruled content-sized with a floor, so
 * the assertion here is only that both fit — the shape is the next story's.
 */
export const ButtonsFitTheCard = meta.story({
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("div > div") as HTMLElement;
    await expect(overflowing(card)).toEqual([]);
  },
});

/**
 * CONTENT-SIZED, WITH A FLOOR (seventh drop, ruling 10). An even split claims
 * the two answers are equally likely, which the card has no business claiming
 * — the agent asked because it expects yes. Allow takes the remaining width
 * (`flex: 1 1 auto`); Deny is content-sized (`flex: 0 0 auto`) and can never
 * become a sliver: never under 96 x 44.
 */
export const AllowLeadsDenyHasAFloor = meta.story({
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("div > div") as HTMLElement;
    const [allow, deny] = [...card.querySelectorAll<HTMLElement>('[role="button"]')];
    const a = allow!.getBoundingClientRect();
    const d = deny!.getBoundingClientRect();
    await expect(d.width).toBeGreaterThanOrEqual(96);
    await expect(d.height).toBeGreaterThanOrEqual(44);
    await expect(a.width).toBeGreaterThan(d.width);
    await expect(getComputedStyle(allow!).flexGrow).toBe("1");
    await expect(getComputedStyle(deny!).flexGrow).toBe("0");
    await expect(overflowing(card)).toEqual([]);
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
