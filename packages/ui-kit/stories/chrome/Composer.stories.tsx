import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { Composer } from "../../src/chrome/Composer.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/Composer",
  component: Composer,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: { variant: "send", hint: "/ for commands" },
  argTypes: { variant: { control: "select", options: ["send", "voice", "plain"] } },
});

/**
 * A thread you are in. The send button is amber because sending is the one
 * primary action this surface has.
 *
 * **This is the wave's one piece of net-new behaviour, not a port.** The design
 * draws the field as a styled `<span>` and its own known-gaps list says to wire
 * it to a real `<textarea>` with `:focus-visible` when implementing. It is
 * wired: ⏎ sends, ⇧⏎ inserts a newline, and the ring is on the field rather
 * than on the box that has the focus.
 */
export const Default = meta.story({});

/** The composer as primary navigation: hold to talk. The button throws a glow
 * the send button does not, because it is the action of a whole screen. */
export const Voice = Default.extend({ args: { variant: "voice", hint: undefined } });

/** Read-only surfaces get the field with no send affordance. */
export const Plain = Default.extend({ args: { variant: "plain" } });

export const NoAttach = Default.extend({ args: { attach: false } });

export const Wide = Default.extend({ parameters: wide });

/** With no `onChange` the field is genuinely `readOnly` rather than a `<span>`
 * dressed as an input: it focuses, it announces itself, and it cannot be typed
 * into. That is honest in a way a `role="textbox"` div is not. */
export const ReadOnly = meta.story({
  play: async ({ canvas }) => {
    const field = await canvas.findByRole("textbox");
    await expect(field).toHaveAttribute("readonly");
    await expect(field).toHaveAccessibleName("Ask your brain anything…");
  },
});

/** Wired. Typing reaches `onChange`, which is the difference between a composer
 * and a picture of one. */
export const Typing = meta.story({
  args: { value: "", onChange: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const field = await canvas.findByRole("textbox");
    await expect(field).not.toHaveAttribute("readonly");
    await userEvent.type(field, "W");
    await expect(args.onChange).toHaveBeenCalledWith("W");
  },
});

/**
 * ⏎ sends and ⇧⏎ does not, per the design's own key table.
 *
 * The second half is the one worth testing: a ⏎ that always sends makes a
 * multi-line question impossible to type, and a ⇧⏎ that also sends makes it
 * impossible to notice.
 */
export const EnterSendsShiftEnterDoesNot = meta.story({
  args: { value: "Where did Circe warn me?", onChange: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const field = await canvas.findByRole("textbox");
    field.focus();

    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect(args.onSend).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    await expect(args.onSend).toHaveBeenCalledWith("Where did Circe warn me?");
  },
});

/** Without `onSend`, ⏎ is just a key: it reaches the textarea and inserts a
 * newline, which is the correct behaviour for a field nobody is listening to. */
export const EnterIsInertWithoutOnSend = meta.story({
  args: { value: "line one", onChange: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const field = await canvas.findByRole("textbox");
    field.focus();
    await userEvent.keyboard("{Enter}");
    // `focus()` leaves the caret at position 0 in a textarea whose value came
    // from props, so the newline lands at the front. Where it lands is the
    // browser's business; that it landed at all is this story's.
    await expect(args.onChange).toHaveBeenCalledWith("\nline one");
  },
});

/** The field grows with a controlled value's newlines and stops at five rows.
 * A pure function of props, at the cost of not growing on soft wrap. */
export const GrowsWithNewlines = meta.story({
  args: { value: "one\ntwo\nthree", onChange: fn() },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("textbox")).toHaveAttribute("rows", "3");
  },
});

/** The send button is a control with a name — "Send", not an unlabelled circle
 * with a glyph in it — and it takes Enter and Space like every other. */
export const SendButtonIsOperable = meta.story({
  args: { value: "hello", onChange: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const send = await canvas.findByRole("button", { name: "Send" });
    await userEvent.click(send);
    await expect(args.onSend).toHaveBeenCalledWith("hello");
  },
});

/**
 * THE CONTRACT, and here it is per affordance. With no `onAttach` and no
 * `onMic` the paperclip and the microphone are the icons the source draws: no
 * role, no ring, no tab stop. The textarea is the one thing that stays
 * focusable, because a read-only field is still a field.
 */
export const Static = meta.story({
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
    await expect(canvasElement.querySelectorAll("[tabindex]")).toHaveLength(0);
    await expect(await canvas.findByRole("textbox")).toBeTruthy();
  },
});
