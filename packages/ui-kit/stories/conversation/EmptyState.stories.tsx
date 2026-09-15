import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { emptyStates } from "../../fixtures/actions.js";
import { EmptyState } from "../../src/conversation/EmptyState.js";
import { stage, wide } from "../_stage.js";

const byVariant = Object.fromEntries(emptyStates.map((e) => [e.variant, e]));

const meta = preview.meta({
  title: "Conversation/EmptyState",
  component: EmptyState,
  decorators: [stage],
  args: { variant: "caught_up" },
  argTypes: { minHeight: { control: { type: "number", min: 0, max: 600, step: 10 } } },
});

/**
 * Screen-level emptiness, where `Placeholder` is card-level. An Actions tab
 * with nothing in it is a whole screen, and that screen reads as REASSURANCE
 * rather than absence — "nothing is waiting on you", not "no data".
 */
export const Default = meta.story({});

export const NoResults = Default.extend({ args: { variant: "no-results" } });

/**
 * `offline` and `first-run` are the same shape because both are states the
 * user can fix. This variant's copy is the one place the port could not use
 * the source's: it named a real VPN product, and `AGENTS.md` bans personal
 * infrastructure outright — a category rule, not a wording one.
 */
export const Offline = Default.extend({ args: { variant: "offline" } });

export const FirstRun = Default.extend({ args: { variant: "first-run" } });
export const Quiet = Default.extend({ args: { variant: "quiet" } });

/** Every variant's copy is a fallback, so a caller can say something more
 * specific without losing the glyph or the tone. */
export const OverriddenCopy = Default.extend({
  args: { ...byVariant["no-results"], variant: "no-results" },
});

/** `minHeight` centres the state inside a screen rather than shrink-wrapping
 * it inside a card. */
export const FullScreen = Default.extend({ args: { minHeight: 420 }, parameters: wide });

export const Wide = Default.extend({ parameters: wide });

/**
 * THE ONE PLACE THIS PORT WIDENS THE API, as wave 2 did for six components:
 * the source draws these buttons and gives no way to operate them. Both
 * callbacks are optional and absent by default, so the render without them is
 * the source's exactly — and D20's gating rule means a button with no handler
 * gets no role and no tab stop.
 */
export const WithActions = meta.story({
  args: {
    variant: "first-run",
    primaryLabel: "Ask something",
    primaryIcon: "chat",
    primaryTone: "primary",
    secondaryLabel: "Index a folder",
    onPrimary: fn(),
    onSecondary: fn(),
  },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Ask something"));
    await expect(args.onPrimary).toHaveBeenCalled();

    await userEvent.click(await canvas.findByText("Index a folder"));
    await expect(args.onSecondary).toHaveBeenCalled();
  },
});

export const DecorativeActions = meta.story({
  args: { variant: "offline", primaryLabel: "Retry", primaryTone: "quiet" },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});
