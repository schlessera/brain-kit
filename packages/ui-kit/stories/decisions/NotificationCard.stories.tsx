import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { notifications } from "../../fixtures/events.js";
import { NotificationCard } from "../../src/decisions/NotificationCard.js";
import type { Tone } from "../../src/types.js";
import { knownContrastGap, stage, wide } from "../_stage.js";

const TONES: Tone[] = ["amber", "teal", "purple", "red", "neutral"];
const [rich, compact, dim] = notifications;

const meta = preview.meta({
  title: "Decisions/NotificationCard",
  component: NotificationCard,
  decorators: [stage],
  args: { ...rich, actions: rich.actions.map((a) => ({ ...a, onClick: fn() })) },
  argTypes: {
    variant: { control: "inline-radio", options: ["rich", "compact", "dim"] },
    tone: { control: "select", options: TONES },
    icon: { control: "text" },
  },
});

/**
 * The variant encodes the notification POLICY, not merely its size: `rich` is
 * an escalation you can act on from the lock screen, `compact` is a receipt,
 * `dim` has been swept into the digest and no action is possible.
 *
 * Escalations push, choices coalesce, FYIs never push — and the card says which
 * of those happened in its own meta line.
 */
export const Rich = meta.story({});

/** The morning digest: a receipt, no actions. */
export const Compact = Rich.extend({ args: { ...compact, actions: [] } });

/** An FYI that never pushed. Dimmed, smaller badge, and nothing to tap. */
/** `dim` is `opacity: .8` on the whole card, which fades the text and its own
 * ground together and lands ink-mute at 3.72:1. See design-feedback §4. */
export const Dim = Rich.extend({
  args: { ...dim, actions: [] },
  parameters: knownContrastGap(
    "NotificationCard dim is opacity .8 on the whole card, which takes ink-mute to 3.72:1. See design-feedback §4 — opacity is a contrast change applied to every colour at once.",
  ),
});

/** All three densities as the lock screen stacks them. */
export const LockScreen = meta.story({
  parameters: {
    ...wide,
    ...knownContrastGap(
      "Stacks the dim variant with the others; same opacity arithmetic as `Dim`. See design-feedback §4.",
    ),
  },
  render: (args) => (
    <>
      {notifications.map((n) => (
        <NotificationCard {...args} key={n.app + n.time} {...n} actions={n.actions} />
      ))}
    </>
  ),
});

/** The badge is filled for `rich` and outlined otherwise, so the accent does
 * two different jobs and takes two different roles — `fill` under a near-black
 * glyph, `ink` as the glyph itself. */
export const Tones = meta.story({
  parameters: wide,
  render: (args) => (
    <>
      {TONES.map((tone) => (
        <NotificationCard {...args} key={tone} tone={tone} actions={[]} meta={`tone · ${tone}`} />
      ))}
    </>
  ),
});

export const WideStory = Rich.extend({ parameters: wide });

/** The two actions are real `Button`s and reach their own callbacks. */
export const Acted = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Approve the fetch"));
    await expect(args.actions?.[0].onClick).toHaveBeenCalled();
    await expect(args.actions?.[1].onClick).not.toHaveBeenCalled();
  },
});

/** THE CONTRACT, delegated to `Button`. Actions with no callbacks render and do
 * nothing — which is what `dim` means. */
export const Static = meta.story({
  args: { actions: rich.actions },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});
