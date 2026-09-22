import preview from "#.storybook/preview";
import { Profiler, useState } from "react";
import { expect, fn } from "storybook/test";

import { Composer } from "../../src/chrome/Composer.js";
import { stage, wide } from "../_stage.js";

/** One line of the field, in px: the `13.5px/1.45` of its `font`. */
const LINE = 13.5 * 1.45;
/** How many lines tall the field is drawn, from its laid-out box. */
const rowsShown = (field: HTMLElement) => Math.round(field.getBoundingClientRect().height / LINE);

/** Wraps to three lines in the 390px stage and has no newline in it. */
const THREE_LINES = "Which of the herdsmen still keep faith with the house, and which of them took the suitors’ silver?";
/** Wraps well past five lines. */
const MANY_LINES =
  "Tell Penelope nothing of the raft until it floats. Tell Telemachus that the bow is still strung and that the axes are where Laertes buried them, twelve in a row below the threshing floor, and that a stranger who can string it is not always a stranger. Tell Eumaeus to count the swine tonight and again at dawn. Tell nobody that I asked.";

/** Every Profiler commit of a `Composer` under `Draft`, so a play function can
 * count what one keystroke costs — and whether the Profiler ran at all.
 *
 * React's PRODUCTION renderer does not call `onRender`: the identifier appears
 * nowhere in `react-dom-client.production.js`. A `storybook build` preview
 * (`packages/ui-kit/README.md`, and the dc-parity tool that serves
 * `storybook-static`) uses that renderer, so there the array stays empty and a
 * bare count would fail on `0` rather than on a real double render. The count
 * below runs where the Profiler is live — `storybook dev` and the Vitest
 * project, which is where this gates — and the same property is held with no
 * renderer at all by `tests/composer-sizing.test.tsx`, which reads the source
 * for the hooks that could cause a second pass. */
let profiled = false;
const commits: string[] = [];

/** A controlled composer with its draft in local state, for the stories that
 * have to type into a field and watch it change size. */
function Draft(props: { initial: string; maxRows?: number }) {
  const [value, setValue] = useState(props.initial);
  return (
    <Profiler
      id="composer"
      onRender={(_, phase) => {
        profiled = true;
        commits.push(phase);
      }}
    >
      <Composer value={value} onChange={setValue} maxRows={props.maxRows} />
    </Profiler>
  );
}

const meta = preview.meta({
  title: "Chrome/Composer",
  component: Composer,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: { variant: "send" },
  argTypes: {
    variant: { control: "select", options: ["send", "voice", "plain"] },
    state: { control: "select", options: ["ready", "streaming", "reconnecting", "offline"] },
  },
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
export const Voice = Default.extend({ args: { variant: "voice", hint: "" } });

/** Read-only surfaces get the field with no send affordance and no attach
 * menu: there is nothing to attach a capture to. */
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

/** The field grows with a controlled value's newlines. The newline count is
 * still written to `rows`: it is the floor a browser without `field-sizing`
 * falls back to, and it is what the value's own line breaks come to. */
export const GrowsWithNewlines = meta.story({
  args: { value: "one\ntwo\nthree", onChange: fn() },
  play: async ({ canvas }) => {
    const field = await canvas.findByRole("textbox");
    await expect(field).toHaveAttribute("rows", "3");
    await expect(rowsShown(field)).toBe(3);
  },
});

/**
 * The field grows with the text it is DISPLAYING, not with the newlines in it.
 * A paragraph typed into a phone-width field wraps, and the wrap is what the
 * reader sees, so it is what the field follows: three visual lines, three rows,
 * with `rows` still at its one-line floor.
 */
export const GrowsOnSoftWrap = meta.story({
  args: { value: THREE_LINES, onChange: fn() },
  play: async ({ canvas }) => {
    const field = await canvas.findByRole("textbox");
    await expect(field).toHaveAttribute("rows", "1");
    await expect(rowsShown(field)).toBe(3);
  },
});

/**
 * Growth stops at the cap and the field scrolls from there. That the caret
 * stays in view while typing at the cap is the browser's own editing
 * behaviour, and a synthetic key event does not trigger it — so that half is
 * proven with real keys in `tests/visual/composer-caret.visual.tsx`.
 */
export const StopsAtTheCap = meta.story({
  render: () => <Draft initial={MANY_LINES} />,
  play: async ({ canvas }) => {
    const field = await canvas.findByRole("textbox");
    await expect(field.getBoundingClientRect().height).toBe(96);
    await expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
    await expect(getComputedStyle(field).overflowY).toBe("auto");
  },
});

/**
 * `maxRows` lowers the cap to that many WHOLE lines — three of them, not three
 * fifths of the default's 96px. Scaling the default's ceiling would spread its
 * deliberate ~4.90-line shortfall to every other row count and clip a
 * three-row field by a pixel, which a constant `maxHeight: 96` never did.
 */
export const StopsAtMaxRows = meta.story({
  render: () => <Draft initial={MANY_LINES} maxRows={3} />,
  play: async ({ canvas }) => {
    const field = await canvas.findByRole("textbox");
    await expect(rowsShown(field)).toBe(3);
    await expect(field.getBoundingClientRect().height).toBeCloseTo(3 * LINE, 1);
    await expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
  },
});

/**
 * Two things a measuring implementation gets wrong, checked together.
 *
 * Shrinking: a field that only ever grows is a field that is five rows tall
 * for the rest of the conversation. Deleting the draft back to nothing returns
 * it to one row.
 *
 * Cost: the composer re-renders on every keystroke by design (the draft lives
 * in the nearest component so nothing above it re-renders), so a fix that
 * measured in a layout effect and set state would commit TWICE per character.
 * The Profiler counts commits; each typed character is exactly one.
 */
export const ShrinksBackAndRendersOnce = meta.story({
  render: () => <Draft initial={THREE_LINES} />,
  play: async ({ canvas, userEvent }) => {
    const field = await canvas.findByRole("textbox");
    await expect(rowsShown(field)).toBe(3);

    await userEvent.clear(field);
    await expect(field).toHaveValue("");
    await expect(rowsShown(field)).toBe(1);

    const before = commits.length;
    await userEvent.type(field, "abc");
    await expect(field).toHaveValue("abc");
    if (profiled) await expect(commits.length - before).toBe(3);
    // And the first character does not jump the box: an empty field sizes from
    // `rows`, a field with text from its content, and one line is one line
    // either way.
    await expect(rowsShown(field)).toBe(1);
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

/* ── The fifth drop: state, provider, recall ──────────────────────────── */

/**
 * `state` drives placeholder, hint and the trailing control TOGETHER, so a
 * connection state can never be half-applied. While a run is live the amber
 * send becomes a red stop, the field stays typeable (you may add to the
 * question), and `esc` inside it is the same stop.
 */
export const Streaming = meta.story({
  args: { state: "streaming", value: "and the harbour?", onChange: fn(), onSend: fn(), onStop: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const stop = await canvas.findByRole("button", { name: "Stop generating" });
    await expect(canvas.queryByRole("button", { name: /^Send/ })).toBeNull();
    const field = await canvas.findByRole("textbox");
    await expect(field).not.toHaveAttribute("readonly");
    await expect(field).toHaveAccessibleName("Add to the question while it works…");

    await userEvent.click(stop);
    await expect(args.onStop).toHaveBeenCalledTimes(1);

    field.focus();
    await userEvent.keyboard("{Escape}");
    await expect(args.onStop).toHaveBeenCalledTimes(2);
  },
});

/** The stop disc exists only while streaming: every other state has the send. */
export const StopOnlyWhileStreaming = meta.story({
  args: { state: "ready", onSend: fn(), onStop: fn() },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button", { name: "Stop generating" })).toBeNull();
    await expect(await canvas.findByRole("button", { name: "Send" })).toBeTruthy();
  },
});

/** Send stays live while the host is being reached again: the question queues
 * locally and goes when the host answers, and the hint says exactly that. */
export const Reconnecting = meta.story({
  args: { state: "reconnecting", value: "hello", onChange: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    await expect(await canvas.findByText("queued locally · sends when the host answers")).toBeTruthy();
    await userEvent.click(await canvas.findByRole("button", { name: "Send" }));
    await expect(args.onSend).toHaveBeenCalledWith("hello");
  },
});

/**
 * Offline is the kit's disabled rule applied to the send: dimmed, inert,
 * `aria-disabled`, out of the tab order, and still NAMED so what is missing is
 * announced. The reason sits in the hint row in gold mono, and the draft stays
 * in the field — ⏎ does not send it and nothing discards it.
 */
export const Offline = meta.story({
  args: { state: "offline", value: "kept draft", onChange: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const send = await canvas.findByRole("button", { name: "Send — unavailable" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await expect(send).toHaveAttribute("tabindex", "-1");
    await expect(send).toHaveStyle({ opacity: "0.45" });
    await expect(await canvas.findByText("needs the host · your draft is kept")).toBeTruthy();

    const field = await canvas.findByRole("textbox");
    await expect(field).toHaveValue("kept draft");
    field.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onSend).not.toHaveBeenCalled();
  },
});

/** An explicit `blockedWhy` replaces the offline default; explicit
 * `placeholder` and `hint` override their state defaults the same way. */
export const OfflineWithReason = Offline.extend({
  args: { blockedWhy: "the host is asleep · try again in a minute", hint: "draft kept" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("the host is asleep · try again in a minute")).toBeTruthy();
    await expect(await canvas.findByText("draft kept")).toBeTruthy();
    await expect(canvas.queryByText("needs the host · your draft is kept")).toBeNull();
  },
});

/** The model sits in the hint row, not the field row: a state you change
 * rarely belongs on the status line. With `onProvider` it is a listbox
 * trigger named after the model. */
export const Provider = meta.story({
  args: { provider: "local · 8b", onProvider: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const chip = await canvas.findByRole("button", { name: "Model — local · 8b" });
    await expect(chip).toHaveAttribute("aria-haspopup", "listbox");
    await expect(chip).toHaveTextContent("local · 8b");
    await userEvent.click(chip);
    await expect(args.onProvider).toHaveBeenCalled();
  },
});

/** D20 for the chip: without `onProvider` the model is text on the status
 * line, not a control. */
export const ProviderStatic = meta.story({
  args: { provider: "local · 8b" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("local · 8b")).toBeTruthy();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});

/** Recalled context sits ABOVE the field because it is content, not a
 * control. Purple by default — recalled context is an untrusted origin — and
 * each chip's × is a real "Remove" button when the app can act on it. */
export const Recall = meta.story({
  args: {
    recall: [
      { label: "Ithaca harbour thread" },
      { label: "circe.md", icon: "file", tone: "teal" },
      { label: "the Vathy shoreline", icon: "image", tone: "amber" },
    ],
    onRecallRemove: fn(),
    onSend: fn(),
  },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Remove circe.md" }));
    await expect(args.onRecallRemove).toHaveBeenCalledWith(1);
  },
});

/** Without `onRecallRemove` the × is the glyph the design draws: no role, no
 * tab stop. The chips are still there, because the context still is. */
export const RecallStatic = meta.story({
  args: { recall: [{ label: "Ithaca harbour thread" }, { label: "circe.md", icon: "file", tone: "teal" }] },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText("Ithaca harbour thread")).toBeTruthy();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelectorAll("[tabindex]")).toHaveLength(0);
  },
});

/** The attach control is a MENU trigger, not a file input: capture (camera,
 * photo, file, paste) is one menu behind one glyph so the field stays the
 * subject of the row. Row order is attach · field · mic · send. */
export const AttachIsAMenu = meta.story({
  args: { onAttach: fn(), onMic: fn(), onSend: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const attach = await canvas.findByRole("button", { name: "Attach — photo, camera, file" });
    await expect(attach).toHaveAttribute("aria-haspopup", "menu");
    const names = (await canvas.findAllByRole("button")).map((b) => b.getAttribute("aria-label"));
    await expect(names).toEqual(["Attach — photo, camera, file", "Dictate", "Send"]);
    await userEvent.click(attach);
    await expect(args.onAttach).toHaveBeenCalled();
  },
});

/** Everything the fifth drop added, in one frame: the busy field with its
 * recalled context, the model on the status line, and the run's stop. */
export const Loaded = meta.story({
  args: {
    state: "streaming",
    provider: "local · 8b",
    onProvider: fn(),
    recall: [{ label: "Ithaca harbour thread" }, { label: "circe.md", icon: "file", tone: "teal" }],
    onRecallRemove: fn(),
    value: "and the harbour?",
    onChange: fn(),
    onSend: fn(),
    onStop: fn(),
    onAttach: fn(),
    onMic: fn(),
  },
});

export const LoadedWide = Loaded.extend({ parameters: wide });
