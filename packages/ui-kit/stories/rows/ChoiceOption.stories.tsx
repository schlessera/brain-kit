import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { askOptions } from "../../fixtures/actions.js";
import { ChoiceOption } from "../../src/rows/ChoiceOption.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Rows/ChoiceOption",
  component: ChoiceOption,
  decorators: [stage],
  args: {
    title: "omens/day-3651-eagle.md",
    subtitle: "Keep it with the other omens. Cross-link to people/penelope.md.",
    selected: true,
    mono: true,
    mark: true,
    onClick: fn(),
  },
});

export const Default = meta.story({});

export const Unselected = Default.extend({ args: { selected: false } });

/** No subtitle centres the mark instead of top-aligning it. */
export const TitleOnly = Default.extend({ args: { subtitle: undefined } });

/** `mono` couples the typeface to teal, because a mono title here is a path. */
export const Prose = Default.extend({
  args: { mono: false, title: "Neither — ask me again after landfall" },
});

/** Italic and dim together are the design's "Other": an option that exists so
 * the list is honest about not being exhaustive. */
export const Other = Default.extend({
  args: {
    mono: false,
    italic: true,
    dim: true,
    selected: false,
    title: "Neither — ask me again after landfall",
    subtitle: "Resurfaces in 17 days with the premise re-checked.",
  },
});

export const WithoutMark = Default.extend({ args: { mark: false } });

export const Wide = Default.extend({ parameters: wide });

/** The three options of the eagle-omen question, in the `radiogroup` a radio
 * needs. `AskUserCard` renders that group for you; this is the hand-rolled
 * equivalent, and it is what the ↑↓ test navigates. */
export const Group = meta.story({
  render: (args) => (
    <div
      role="radiogroup"
      aria-label="Where should the eagle omen live?"
      style={{ display: "flex", flexDirection: "column", gap: 7, width: "100%" }}
    >
      {askOptions.map((o) => (
        <ChoiceOption {...args} key={o.title} {...o} />
      ))}
    </div>
  ),
});

/** Space picks the focused option, per the design's key table. */
export const Picked = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const option = await canvas.findByRole("radio");
    await expect(option).toHaveAttribute("aria-checked", "true");
    await userEvent.click(option);
    await expect(args.onClick).toHaveBeenCalledTimes(1);

    option.focus();
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
});

/**
 * ↑↓ moves between options and wraps at both ends — the other half of the
 * design's "↑↓ then space". Navigation is scoped to the enclosing
 * `radiogroup`, so two groups on one screen do not reach into each other.
 */
export const ArrowKeys = Group.extend({
  play: async ({ canvas, userEvent }) => {
    const options = await canvas.findAllByRole("radio");
    await expect(options).toHaveLength(3);

    options[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(options[1]);
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowDown}");
    // Wrapped back to the first rather than stopping at the last.
    await expect(document.activeElement).toBe(options[0]);
    await userEvent.keyboard("{ArrowUp}");
    await expect(document.activeElement).toBe(options[2]);
  },
});

/**
 * THE CONTRACT. No handler, no `radio` role, no `aria-checked`, no tab stop and
 * no hover — a list of options with no callbacks is a record of a choice
 * already made, not a control.
 */
export const Static = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector("[aria-checked]")).toBeNull();
  },
});
