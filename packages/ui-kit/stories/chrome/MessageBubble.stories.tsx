import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { answerStats, answerTrace, userMessage } from "../../fixtures/search.js";
import { StatTiles } from "../../src/blocks/StatTiles.js";
import { MessageBubble } from "../../src/chrome/MessageBubble.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/MessageBubble",
  component: MessageBubble,
  decorators: [stage],
  args: { role: "user", text: userMessage },
  argTypes: { role: { control: "select", options: ["user", "brain"] } },
});

/** A tucked bubble, right-aligned, one corner cut so it points back at the
 * person who typed it. Capped at 82% so a short question stays short. */
export const User = meta.story({});

/**
 * **No bubble at all — the answer IS the page.** What wraps it instead is
 * provenance: a collapsed tool trace above and the response actions below. A
 * bubble would say "a message"; a full-column answer says "this is the document
 * you asked for", and the trace line is what makes that claim checkable.
 */
export const Brain = User.extend({
  args: {
    role: "brain",
    trace: answerTrace,
    text: "Circe named her on Aeaea, the morning you sailed — six heads, six men, one pass. You did not tell the crew.",
  },
});

/** A brain turn with the action row suppressed, for a transcript still
 * streaming: there is nothing to copy yet. */
export const NoActions = Brain.extend({ args: { actions: false } });

/** Without a trace there is no provenance line, and the answer stands alone.
 * The design leaves that possible; it is not the shape to prefer. */
export const NoTrace = Brain.extend({ args: { trace: undefined } });

/** `children` is the slot the in-chat blocks land in. Same slot for both roles:
 * inside the bubble for a user turn, inside the prose for a brain turn. */
export const WithBlock = Brain.extend({
  render: (args) => (
    <MessageBubble {...args}>
      <div style={{ marginTop: 10 }}>
        <StatTiles tiles={answerStats} />
      </div>
    </MessageBubble>
  ),
});

export const Wide = User.extend({ parameters: wide });

/**
 * The asymmetry, asserted rather than described: a user turn has a background
 * and a border, a brain turn has neither.
 */
export const OnlyTheUserGetsABubble = meta.story({
  play: async ({ canvas }) => {
    const user = (await canvas.findByText(userMessage)) as HTMLElement;
    await expect(getComputedStyle(user).borderTopWidth).toBe("1px");
    await expect(getComputedStyle(user).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  },
});

/** A user turn never shows a trace, even when one is passed — the trace belongs
 * to an answer, and a question has no steps. */
export const UserTurnHasNoTrace = meta.story({
  args: { role: "user", trace: answerTrace },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText(answerTrace)).toBeNull();
  },
});

/**
 * The response actions are four icons with NO roles and no tab stops. That is
 * the source exactly, and it is a recorded accessibility gap rather than an
 * oversight: copy, share, upvote and retry are four real actions this component
 * has no callbacks for, so wiring them is API widening the design has not asked
 * for. D17 lists it for the accessibility wave.
 */
export const ActionsAreNotWiredYet = meta.story({
  args: { role: "brain", trace: answerTrace },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelectorAll("svg")).toHaveLength(6);
  },
});
