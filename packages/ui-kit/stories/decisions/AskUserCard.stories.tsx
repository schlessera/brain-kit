import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { askOptions, askUser } from "../../fixtures/actions.js";
import { AskUserCard } from "../../src/decisions/AskUserCard.js";
import { knownContrastGap, stage, wide } from "../_stage.js";

const options = askOptions.map((o) => ({ ...o, onClick: fn() }));

const meta = preview.meta({
  title: "Decisions/AskUserCard",
  component: AskUserCard,
  decorators: [stage],
  args: {
    prompt: askUser.prompt,
    question: askUser.question,
    tag: askUser.tag,
    tone: "purple",
    options,
    showActions: true,
    primaryLabel: "Submit",
    secondaryLabel: "Dismiss",
    onPrimary: fn(),
    onSecondary: fn(),
  },
  argTypes: { tone: { control: "inline-radio", options: ["teal", "amber", "purple"] } },
  // Every story here shows a SELECTED option, and a selected option's detail
  // line is ink-mute on the teal selection tint: 4.36:1, against a 4.5 floor.
  // The card is not doing anything unusual — this is the ink ramp meeting a
  // tint, which is §5 in `.plan/design-feedback.md`, and it is the reason
  // the gap is at the meta rather than on nine separate stories.
  parameters: knownContrastGap(
    "ChoiceOption's detail line is ink-mute on the teal selection tint: 4.36:1. See design-feedback §5 — the ink floor is measured on a BARE ground and the kit rarely has one.",
  ),
});

/**
 * The agent has stopped and the next move is the user's.
 *
 * Both real options name the exact path and what would be written there, which
 * is the design's rule: the effect is the UI, not the label. The third is
 * "Neither" — an option that exists so the list is honest about not being
 * exhaustive.
 */
export const Default = meta.story({});

/** Teal is the default tone: the choice belongs to the user. Purple is for
 * material that arrived from outside, which is why the eagle omen uses it. */
export const Teal = Default.extend({ args: { tone: "teal" } });

export const Amber = Default.extend({ args: { tone: "amber" } });

/** No tag, no buttons: the form the card takes inside a transcript where the
 * option tap IS the submission. */
export const OptionsOnly = Default.extend({ args: { tag: undefined, showActions: false } });

export const Wide = Default.extend({ parameters: wide });

/**
 * The card renders the `radiogroup` its options require, labelled by the
 * question — so the group is announced by what it is asking rather than by a
 * generic name. `ChoiceOption` cannot render it: it is one option, and the
 * group is the caller's.
 */
export const Radiogroup = meta.story({
  play: async ({ canvas }) => {
    const group = await canvas.findByRole("radiogroup");
    await expect(group).toHaveAccessibleName(askUser.question);
    await expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
  },
});

/** ↑↓ then space, end to end: arrow to the second option, pick it, then submit. */
export const Answered = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const radios = await canvas.findAllByRole("radio");
    await expect(radios[0]).toHaveAttribute("aria-checked", "true");

    radios[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(radios[1]);
    await userEvent.keyboard(" ");
    await expect(args.options?.[1].onClick).toHaveBeenCalled();

    await userEvent.click(await canvas.findByText("Submit"));
    await expect(args.onPrimary).toHaveBeenCalled();
  },
});

/** Arrow navigation does not escape the group, which is what makes two cards on
 * one screen safe. */
export const TwoCards = meta.story({
  parameters: wide,
  render: (args) => (
    <>
      <AskUserCard {...args} id="first" />
      <AskUserCard {...args} id="second" tone="teal" question="Tie me to the mast, or wax for everyone?" />
    </>
  ),
  play: async ({ canvas, userEvent }) => {
    const groups = await canvas.findAllByRole("radiogroup");
    await expect(groups).toHaveLength(2);
    const firstGroupRadios = [...groups[0].querySelectorAll<HTMLElement>('[role="radio"]')];

    firstGroupRadios[2].focus();
    await userEvent.keyboard("{ArrowDown}");
    // Wrapped to the top of its OWN group, not into the second card.
    await expect(document.activeElement).toBe(firstGroupRadios[0]);
  },
});

/**
 * THE CONTRACT, delegated. Options with no callbacks get no `radio` role and no
 * tab stop, and the card renders no `radiogroup` around them — a card showing
 * which option was taken is a record, not a question.
 */
export const Static = meta.story({
  args: { options: askOptions, showActions: false },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("radiogroup")).toBeNull();
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

/**
 * ONE TAB STOP FOR THE WHOLE QUESTION.
 *
 * The card owns the `radiogroup`, so it owns the roving tabindex too: Tab lands
 * on the selected option, ↑↓ move between the three, Tab leaves for the Dismiss
 * and Submit buttons. `ChoiceOption` cannot decide this for itself — it is one
 * option and cannot see its siblings — so the card computes it and passes
 * `tabStop`.
 */
export const OneTabStopForTheGroup = meta.story({
  play: async ({ canvas, userEvent }) => {
    const group = await canvas.findByRole("radiogroup");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    await expect(radios).toHaveLength(3);
    await expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    // The selected option is the stop, so tabbing in puts you on your answer.
    await expect(radios[0]).toHaveAttribute("tabindex", "0");

    await userEvent.tab();
    await expect(document.activeElement).toBe(radios[0]);
    // Out of the group in one press, into the card's own buttons.
    await userEvent.tab();
    await expect(group.contains(document.activeElement)).toBe(false);
  },
});

/** The stop follows the caret: arrow down, leave, come back, and you are where
 * you left off rather than back on the selected option. */
export const TheStopFollowsTheCaret = meta.story({
  play: async ({ canvas, userEvent }) => {
    const group = await canvas.findByRole("radiogroup");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    radios[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(radios[1]);
    await expect(radios[1]).toHaveAttribute("tabindex", "0");
    await expect(radios[0]).toHaveAttribute("tabindex", "-1");
  },
});

/**
 * THE HAZARD, and the reason the stop is not just "the selected option".
 *
 * A question nobody has answered yet has NO selected option — which is the
 * common case, not an edge one — and "the selected option is the stop" would
 * leave every option at `tabIndex={-1}` and the whole question unreachable from
 * the keyboard. The stop falls to the first interactive option instead.
 */
export const AnUnansweredQuestionIsStillReachable = meta.story({
  args: { options: askOptions.map((o) => ({ ...o, selected: false, onClick: fn() })) },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const group = await canvas.findByRole("radiogroup");
    await expect(group.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
    await expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(true);
    await expect(document.activeElement).toBe(group.querySelector('[role="radio"]'));
  },
});
