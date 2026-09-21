import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { askOptions, askUser, followAnswers, followOptions, followQuestion } from "../../fixtures/actions.js";
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
  // tint, which is §5 in `docs/decisions/design-feedback.md`, and it is the reason
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

/* ── The three states of the exchange (sixth drop) ─────────────────────── */

/** No opacity anywhere in the card: a past question is not lower-contrast,
 * it is answered. Read off the rendered tree so a fade on any wrapper fails. */
async function expectFullContrast(root: HTMLElement) {
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    await expect(`${el.tagName.toLowerCase()} opacity ${getComputedStyle(el).opacity}`).toBe(
      `${el.tagName.toLowerCase()} opacity 1`,
    );
  }
}

/**
 * ANSWERED. The chosen answer, checked and in the accent, with when. The
 * options are GONE, not dimmed — the alternatives were never the record, the
 * decision was — and so are the buttons. The card keeps its tinted border so
 * the exchange is still findable by scanning colour.
 */
export const AnsweredState = meta.story({
  args: {
    state: "answered",
    prompt: undefined,
    answer: askOptions[0].title,
    answerMeta: "you chose this · 2m ago",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvas.queryByRole("radiogroup")).toBeNull();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.queryByText("Submit")).toBeNull();
    await expect(canvas.getByText(askOptions[0].title)).toBeInTheDocument();
    await expect(canvas.getByText("Answered")).toBeInTheDocument();
    await expectFullContrast(canvasElement);
  },
});

/**
 * TYPED. The user answered in the composer instead of picking, so the agent
 * bound that message to the question and the card quotes what it took. Dropping
 * the card would leave the transcript claiming the question was never
 * answered; leaving it pending would ask twice. Neutral border: the exchange
 * closed, but not through this card.
 */
export const TypedState = meta.story({
  args: {
    state: "typed",
    prompt: undefined,
    answer: "“file it with the omens, and tell Eumaeus”",
    answerMeta: "taken from your next message · 2m ago",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.queryByText("Dismiss")).toBeNull();
    await expect(canvas.getByText("Answered in the composer")).toBeInTheDocument();
    await expect(canvas.getByText("“file it with the omens, and tell Eumaeus”")).toBeInTheDocument();
    await expectFullContrast(canvasElement);
  },
});

/** Pending is the default, and it keeps full contrast too — the three states
 * differ in what they show, never in how loud they are. */
export const PendingState = meta.story({
  args: { state: "pending" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getAllByRole("radio")).toHaveLength(3);
    await expect(canvas.getAllByRole("button")).toHaveLength(2);
    await expectFullContrast(canvasElement);
  },
});

/**
 * "OTHER" OPENS A REAL FIELD in place of the Submit row rather than a modal:
 * a free-text answer is the same exchange, not a new one. Enter submits the
 * text through `onOtherSubmit`. The field only exists while pending — a closed
 * exchange takes no answer.
 */
export const OtherOpen = meta.story({
  args: { otherOpen: true, otherPlaceholder: "Type where it should go…", onOtherSubmit: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const input = await canvas.findByRole("textbox", { name: "Your own answer" });
    await expect(input).toHaveAttribute("placeholder", "Type where it should go…");
    // The Submit row gave its place to the field.
    await expect(canvas.queryByText("Submit")).toBeNull();
    await expect(canvas.queryByText("Dismiss")).toBeNull();
    // The options are still there: the field is an answer, not a state change.
    await expect(canvas.getAllByRole("radio")).toHaveLength(3);

    await userEvent.type(input, "put it with the other omens{Enter}");
    await expect(args.onOtherSubmit).toHaveBeenCalledWith("put it with the other omens");
  },
});

/** `otherOpen` on a closed exchange draws nothing: the field belongs to the
 * pending state alone. */
export const OtherIgnoredOnceAnswered = meta.story({
  args: { state: "answered", otherOpen: true, answer: askOptions[0].title },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
});

/**
 * DISMISSED — the fourth state (seventh drop, ruling 7), not pending with a
 * note. The head and border say WHO closed the question: you (answered,
 * accent) · you elsewhere (typed, neutral) · nobody (dismissed, gold, because
 * an unanswered premise is the kit's caution case and may have rotted). No
 * options, no Submit; a lapsed row states the fact and offers "Ask again",
 * because the agent stopped needing the answer but you may still owe it one.
 */
export const DismissedState = meta.story({
  args: { state: "dismissed", prompt: undefined, onAskAgain: fn() },
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    await expect(canvas.getByText("Unanswered — the turn ended")).toBeInTheDocument();
    await expect(canvas.getByText("the run ended before you answered · nothing was filed")).toBeInTheDocument();
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvas.queryByRole("radiogroup")).toBeNull();
    await expect(canvas.queryByText("Submit")).toBeNull();
    await expect(canvas.queryByText("Dismiss")).toBeNull();
    await expectFullContrast(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Ask again" }));
    await expect(args.onAskAgain).toHaveBeenCalledTimes(1);
  },
});

/** D20: no `onAskAgain`, no button. The lapsed row still states the fact,
 * and `lapsedNote` overrides its wording. */
export const DismissedWithoutAskAgain = DismissedState.extend({
  args: { onAskAgain: undefined, lapsedNote: "the run ended before you answered · the omen went unfiled" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("the run ended before you answered · the omen went unfiled")).toBeInTheDocument();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});

/* ── Multi-select (seventh drop, ruling 6) ─────────────────────────────── */

const multiOptions = followOptions.map((o) => ({ ...o, onClick: fn() }));

/**
 * `multi` is the answer shape, not a control the app happens to need. The
 * options are `ChoiceOption multiple` — checkbox role, square mark — inside a
 * `role="group"` labelled by the question (not a `radiogroup`: two checked
 * radios would be a lie to assistive tech), and the group is still ONE tab
 * stop with ↑↓ inside it.
 */
export const MultiPending = meta.story({
  args: {
    multi: true,
    tone: "teal",
    prompt: undefined,
    question: followQuestion.question,
    tag: followQuestion.tag,
    options: multiOptions,
    primaryLabel: "Keep 2",
  },
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    await expect(canvas.queryByRole("radiogroup")).toBeNull();
    await expect(canvas.queryByRole("radio")).toBeNull();
    const group = await canvas.findByRole("group");
    await expect(group).toHaveAccessibleName(followQuestion.question);
    const boxes = [...group.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    await expect(boxes).toHaveLength(3);
    await expect(boxes.filter((b) => b.getAttribute("aria-checked") === "true")).toHaveLength(2);
    for (const box of boxes) await expect(getComputedStyle(box.firstElementChild!).borderRadius).toBe("5px");
    await expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await expectFullContrast(canvasElement);

    // One stop, arrows inside, space toggles.
    await userEvent.tab();
    await expect(group.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(document.activeElement).toBe(boxes[2]);
    await userEvent.keyboard(" ");
    await expect(args.options?.[2].onClick).toHaveBeenCalledTimes(1);
    await userEvent.tab();
    await expect(group.contains(document.activeElement)).toBe(false);
  },
});

/** Answered, multi: the head counts what was chosen, every choice is its own
 * row, and the meta sits under the first alone. Nothing fades. */
export const MultiAnswered = meta.story({
  args: {
    state: "answered",
    multi: true,
    tone: "teal",
    prompt: undefined,
    question: followQuestion.question,
    tag: followQuestion.tag,
    answers: followAnswers,
    answerMeta: undefined,
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Answered · 2 chosen")).toBeInTheDocument();
    for (const a of followAnswers) await expect(canvas.getByText(a)).toBeInTheDocument();
    await expect(canvas.getAllByText(/you chose 2/)).toHaveLength(1);
    await expect(canvas.queryByRole("checkbox")).toBeNull();
    await expect(canvas.queryByRole("group")).toBeNull();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expectFullContrast(canvasElement);
  },
});

/** The four states stacked, the way the catalog's §13 shows them. */
export const FourStates = meta.story({
  parameters: wide,
  render: (args) => (
    <>
      <AskUserCard {...args} id="pending" otherOpen />
      <AskUserCard {...args} id="answered" state="answered" prompt={undefined} answer={askOptions[0].title} answerMeta="you chose this · 2m ago" />
      <AskUserCard
        {...args}
        id="typed"
        state="typed"
        prompt={undefined}
        answer="“file it with the omens, and tell Eumaeus”"
        answerMeta="taken from your next message · 2m ago"
      />
      <AskUserCard {...args} id="dismissed" state="dismissed" prompt={undefined} onAskAgain={fn()} />
    </>
  ),
});
