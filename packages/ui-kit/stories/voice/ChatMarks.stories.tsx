import preview from "#.storybook/preview";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { MessageBubble } from "../../src/chrome/MessageBubble.js";
import { ConversationEndDivider, SpokenTurn, UncertainWord, UnplayedText, VoiceToolChip, type SpokenTurnDetails } from "../../src/voice/SpokenTurn.js";
import { stage } from "../_stage.js";
import { reducedMotion, voiceA11y } from "./_checks.js";
import { CHAT } from "./_voice.js";

/**
 * Spoken turns in the chat (#3692): evidence as styling, not diagnostics.
 * A spoken turn carries an inline amber mic (you) or teal speaker (brain); a
 * typed turn carries none. Uncertain words are dotted, unplayed reply text is
 * dimmed, tool work is a chip, and the end of a conversation is a divider.
 * No provider codes, epochs or "?" glyphs.
 */
const meta = preview.meta({
  title: "Voice/Chat marks",
  decorators: [stage],
});

const marks = (root: HTMLElement) => ({
  you: root.querySelectorAll('.bk-spoken-mark[data-speaker="you"]').length,
  brain: root.querySelectorAll('.bk-spoken-mark[data-speaker="brain"]').length,
});

/** A typed exchange, then a spoken one: only the spoken turns carry a mark. */
export const TypedVsSpoken = meta.story({
  render: () => (
    <>
      <MessageBubble role="user" text={CHAT.ask} />
      <MessageBubble role="brain" text={CHAT.answer} actions={false} />
      <SpokenTurn speaker="you">{CHAT.spoken}</SpokenTurn>
      <SpokenTurn speaker="brain">{CHAT.reply} {CHAT.replyTail}</SpokenTurn>
    </>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(marks(canvasElement)).toEqual({ you: 1, brain: 1 });
    await expect(canvas.getByRole("img", { name: "Spoken by you" })).toBeVisible();
    await expect(canvas.getByRole("img", { name: "Spoken by brain" })).toBeVisible();
    await voiceA11y(canvasElement);
  },
});

/** Your words build in an outlined bubble with an amber cursor. */
export const InProgress = meta.story({
  render: () => <SpokenTurn speaker="you" inProgress>When is Calypso’s</SpokenTurn>,
  play: async ({ canvasElement }) => {
    const bubble = canvasElement.querySelector(".bk-spoken-bubble")!;
    await expect(bubble.getAttribute("data-in-progress")).toBe("true");
    await expect(canvasElement.querySelector(".bk-voice-cursor"), "cursor").not.toBeNull();
  },
});

/** A word recognition was unsure of: dotted, and named as uncertain. Never invented. */
export const UncertainWordInTurn = meta.story({
  name: "Uncertain word",
  render: () => <SpokenTurn speaker="you">When is <UncertainWord onClick={fn()}>Calypso’s</UncertainWord> axe back?</SpokenTurn>,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: /Calypso’s \(uncertain\)/ })).toBeVisible();
    await voiceA11y(canvasElement);
  },
});

/** Words brighten as they are played; the rest waits, dimmed. */
export const PartlyPlayed = meta.story({
  render: () => <SpokenTurn speaker="brain">{CHAT.reply} <UnplayedText>{CHAT.replyTail}</UnplayedText></SpokenTurn>,
  play: async ({ canvasElement }) => {
    const tail = canvasElement.querySelector(".bk-unplayed")!;
    await expect(getComputedStyle(tail).color).not.toBe(getComputedStyle(tail.parentElement!).color);
  },
});

/** Talked over: the unplayed words stay dimmed, with a quiet "cut off" tag. */
export const CutOff = meta.story({
  render: () => <SpokenTurn speaker="brain" cutOff>{CHAT.reply} <UnplayedText>{CHAT.replyTail}</UnplayedText></SpokenTurn>,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("cut off")).toBeVisible();
  },
});

/** Tool work during a conversation: a running chip, then a ticked one. */
export const ToolChips = meta.story({
  render: () => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <VoiceToolChip state="running" label="Checking the timber tally" />
      <VoiceToolChip state="done" label="Read the timber tally" />
    </div>
  ),
});

/** The end of a conversation: duration and persona, between hairlines. */
export const EndDivider = meta.story({
  render: () => <ConversationEndDivider label="Live · 1:12 · Ithaca steward" />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("separator", { name: /Live conversation ended/ })).toBeVisible();
  },
});

/** A turn saved before provenance existed renders plain: no mark is guessed. */
export const LegacyTurn = meta.story({
  render: () => <MessageBubble role="user" text={CHAT.spoken} />,
  play: async ({ canvasElement }) => {
    await expect(marks(canvasElement)).toEqual({ you: 0, brain: 0 });
  },
});

/** Every mark in one conversation, for review and the baselines. */
export const AllMarks = meta.story({
  parameters: { stageWidth: 560 },
  render: () => (
    <>
      <MessageBubble role="user" text={CHAT.ask} />
      <MessageBubble role="brain" text={CHAT.answer} actions={false} />
      <SpokenTurn speaker="you">When is <UncertainWord onClick={fn()}>Calypso’s</UncertainWord> axe back?</SpokenTurn>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <VoiceToolChip state="done" label="Read the timber tally" />
        <VoiceToolChip state="running" label="Checking the yard" />
      </div>
      <SpokenTurn speaker="brain" cutOff>{CHAT.reply} <UnplayedText>{CHAT.replyTail}</UnplayedText></SpokenTurn>
      <SpokenTurn speaker="you" inProgress>Which twelfth</SpokenTurn>
      <ConversationEndDivider label="Live · 1:12 · Ithaca steward" />
      <MessageBubble role="user" text="Legacy turn, saved before spoken marks." />
    </>
  ),
  play: async ({ canvasElement }) => {
    await expect(marks(canvasElement)).toEqual({ you: 2, brain: 1 });
    await voiceA11y(canvasElement);
  },
});

/** Reduced motion: the cursor is solid and the running chip is still. */
export const ReducedMotion = AllMarks.extend({
  render: () => (
    <div data-motion="reduce" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <SpokenTurn speaker="you" inProgress>Which twelfth</SpokenTurn>
      <VoiceToolChip state="running" label="Checking the yard" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await reducedMotion(canvasElement);
  },
});

/*
 * Spoken-turn details without the glyph (#3728). Each spoken turn has one
 * visually hidden "Details" stop: Tab shows it as a pill on the bubble's outer
 * bottom corner, and Enter, Space, Shift+F10 or the ContextMenu key opens the
 * same transcript details dialog the glyph opens today. A pointer hover shows
 * the pill after 300ms; a right-click opens the details unless text inside
 * the turn is selected; a long-press shows the pressed veil at 150ms and opens
 * them at 500ms. Nothing is shown at rest, and no glyph renders.
 */

const HEARD: SpokenTurnDetails = {
  kind: "recognized",
  source: "Gemini Live",
  finish: "finished",
  evidenceLabel: "Technical evidence (2 fragments)",
  children: <p>Two recognition fragments; speaker unverified. Timing: 0:41 to 0:44.</p>,
};

const SAID: SpokenTurnDetails = {
  kind: "generated",
  source: "Gemini Live",
  playback: "unknown",
  evidenceLabel: "Technical evidence (generated reply)",
  children: <p>One generated reply; playback position unknown.</p>,
};

const YOURS = "Recognized speech; Gemini Live; unverified. Transcript details.";
const BRAINS = "Voice reply; Gemini Live; playback unknown. Transcript details.";

/** Your bubble and brain's reply, wide enough at desktop to show both corners. */
const detailStage = { stageWidth: 560 };

const DetailTurns = () => (
  <>
    <MessageBubble role="user" text={CHAT.ask} />
    <SpokenTurn speaker="you" details={HEARD}>When is <UncertainWord onClick={fn()}>Calypso’s</UncertainWord> axe back?</SpokenTurn>
    <SpokenTurn speaker="brain" details={SAID}>{CHAT.reply} {CHAT.replyTail}</SpokenTurn>
  </>
);

const stopOf = (root: HTMLElement, name: string) => within(root).getByRole("button", { name });
const turnOf = (root: HTMLElement, speaker: "you" | "brain") => root.querySelector<HTMLElement>(`.bk-spoken-turn[data-speaker="${speaker}"]`)!;
const dialog = (root: HTMLElement) => within(root.ownerDocument.body).queryByRole("dialog", { name: "Transcript details" });
/** Shown means unclipped; the opacity fades in over 120ms, so it is awaited where it matters. */
const shown = (stop: HTMLElement) => getComputedStyle(stop).clipPath === "none";

/** No glyph inside or beside a spoken turn: the only icon is the spoken mark. */
async function noGlyph(root: HTMLElement) {
  await expect(root.querySelector(".bk-transcript-glyphs, .bk-transcript-qualifiers"), "no evidence glyph").toBeNull();
  for (const turn of root.querySelectorAll(".bk-spoken-turn")) await expect(turn.querySelectorAll("svg"), "only the spoken mark").toHaveLength(1);
}

/** Close the dialog with Escape and prove focus is back on the Details stop. */
async function closeBackTo(root: HTMLElement, stop: HTMLElement) {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(dialog(root)).toBeNull());
  await waitFor(() => expect(stop).toHaveFocus());
}

/** At rest: no pill, no glyph, but one named stop per spoken turn. Typed turns add none. */
export const DetailsAtRest = meta.story({
  parameters: detailStage,
  name: "Details · rest",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    await noGlyph(canvasElement);
    for (const name of [YOURS, BRAINS]) {
      const stop = stopOf(canvasElement, name);
      await expect(stop.getAttribute("aria-haspopup")).toBe("dialog");
      await expect(getComputedStyle(stop).display, "clipped, not display:none").not.toBe("none");
      await expect(getComputedStyle(stop).clipPath).toBe("inset(50%)");
    }
    await expect(canvasElement.querySelectorAll("[data-transcript-trigger]"), "one stop per spoken turn").toHaveLength(2);
    const bubble = canvasElement.querySelector<HTMLElement>(".bk-spoken-bubble")!;
    const height = bubble.getBoundingClientRect().height;
    await userEvent.tab();
    await userEvent.tab();
    await expect(bubble.getBoundingClientRect().height, "the pill never moves the chat").toBe(height);
    await voiceA11y(canvasElement);
  },
});

/**
 * Keyboard only: Tab reaches the turn's Details stop, Enter opens the
 * transcript details with focus on the heading, and Escape closes them and
 * returns focus to the stop. Shift+F10 opens them too, from the stop or from
 * the uncertain word's own button.
 */
export const DetailsKeyboard = meta.story({
  parameters: detailStage,
  name: "Details · keyboard only",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const word = within(canvasElement).getByRole("button", { name: /Calypso’s \(uncertain\)/ });
    const yours = stopOf(canvasElement, YOURS);
    await userEvent.tab();
    await expect(word, "the uncertain word keeps its stop").toHaveFocus();
    await userEvent.tab();
    await expect(yours).toHaveFocus();
    await expect(shown(yours), "pill shows on focus").toBe(true);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(body.getByRole("heading", { name: "Transcript details" })).toHaveFocus());
    await waitFor(() => expect(body.getByText("Recognized speech. Words may be uncertain; speaker unverified.")).toBeVisible());
    await closeBackTo(canvasElement, yours);

    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await waitFor(() => expect(dialog(canvasElement)).not.toBeNull());
    await closeBackTo(canvasElement, yours);

    await userEvent.tab({ shift: true });
    await expect(word).toHaveFocus();
    await userEvent.keyboard("{ContextMenu}");
    await waitFor(() => expect(dialog(canvasElement)).not.toBeNull());
    await closeBackTo(canvasElement, yours);

    await userEvent.tab();
    const brains = stopOf(canvasElement, BRAINS);
    await expect(brains, "Tab goes on to the next spoken turn").toHaveFocus();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(body.getByText("Generated voice reply. This is service-generated text, not a host task result.")).toBeVisible());
    await closeBackTo(canvasElement, brains);
  },
});

/** The Details stop focused: the pill on your bubble's outer bottom corner. */
export const DetailsFocused = meta.story({
  parameters: detailStage,
  name: "Details · focused",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    await userEvent.tab();
    const stop = stopOf(canvasElement, YOURS);
    await expect(stop).toHaveFocus();
    await expect(shown(stop)).toBe(true);
    await waitFor(() => expect(getComputedStyle(stop).opacity).toBe("1"));
    const pill = stop.querySelector(".bk-transcript-pill")!.getBoundingClientRect();
    const bubble = canvasElement.querySelector(".bk-spoken-bubble")!.getBoundingClientRect();
    await expect(Math.round(pill.height), "24px pill").toBe(24);
    await expect(pill.right, "outer corner: right for yours").toBeLessThanOrEqual(bubble.right);
    await expect(pill.right).toBeGreaterThan(bubble.right - 24);
    await expect(pill.top).toBeLessThan(bubble.bottom);
    await expect(pill.bottom).toBeGreaterThan(bubble.bottom);
    await voiceA11y(canvasElement);
  },
});

/** A pointer resting on brain's reply shows its pill after 300ms; a click opens the details. */
export const DetailsHover = meta.story({
  parameters: detailStage,
  name: "Details · hover",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    const turn = turnOf(canvasElement, "brain");
    const stop = stopOf(canvasElement, BRAINS);
    await userEvent.hover(turn.querySelector(".bk-spoken-prose")!);
    await expect(shown(stop), "not before the delay").toBe(false);
    await waitFor(() => expect(shown(stop)).toBe(true), { timeout: 1000 });
    await expect(turn.dataset.reveal).toBe("true");
    const pill = stop.querySelector(".bk-transcript-pill")!.getBoundingClientRect();
    await expect(pill.left, "outer corner: left for brain's").toBeGreaterThanOrEqual(turn.getBoundingClientRect().left);
    await expect(pill.left).toBeLessThan(turn.getBoundingClientRect().left + 24);
  },
});

/** Hover, then click the pill: the same dialog, and focus returns to the stop. */
export const DetailsHoverClick = DetailsHover.extend({
  name: "Details · hover and click",
  play: async ({ canvasElement }) => {
    const stop = stopOf(canvasElement, BRAINS);
    await userEvent.hover(turnOf(canvasElement, "brain").querySelector(".bk-spoken-prose")!);
    await waitFor(() => expect(shown(stop)).toBe(true), { timeout: 1000 });
    await userEvent.click(stop);
    await waitFor(() => expect(dialog(canvasElement)).not.toBeNull());
    await closeBackTo(canvasElement, stop);
  },
});

/**
 * A long-press frame: the existing hover veil and edge as the pressed state,
 * shown at 150ms, with no ring and no scale. The press is held here so the
 * frame can be reviewed; `Details · long-press` runs the real timing.
 */
export const DetailsPressed = meta.story({
  parameters: detailStage,
  name: "Details · long-press pressed",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    for (const turn of canvasElement.querySelectorAll<HTMLElement>(".bk-spoken-turn")) turn.setAttribute("data-pressed", "true");
    const bubble = getComputedStyle(canvasElement.querySelector(".bk-spoken-bubble")!);
    await expect(bubble.backgroundImage, "veil").not.toBe("none");
    await expect(bubble.transform, "no scale").toBe("none");
    await expect(shown(stopOf(canvasElement, YOURS)), "no pill on a press").toBe(false);
  },
});

const touch = (target: Element, type: string, x: number, y: number) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: "touch", pointerId: 7, isPrimary: true, clientX: x, clientY: y }));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long-press, timed: the veil at 150ms, the details at 500ms, and the finger
 * lifting does not also tap the uncertain word under it. Moving more than
 * 10px, or a pointercancel, aborts so scrolling is unaffected.
 */
export const DetailsLongPress = meta.story({
  parameters: detailStage,
  name: "Details · long-press",
  args: { onWord: fn() },
  render: (args) => (
    <SpokenTurn speaker="you" details={HEARD}>When is <UncertainWord onClick={args.onWord}>Calypso’s</UncertainWord> axe back?</SpokenTurn>
  ),
  play: async ({ args, canvasElement }) => {
    const turn = turnOf(canvasElement, "you");
    const word = canvasElement.querySelector(".bk-uncertain-btn")!;
    const box = word.getBoundingClientRect();
    const [x, y] = [box.left + 4, box.top + 4];

    touch(word, "pointerdown", x, y);
    await pause(60);
    await expect(turn.dataset.pressed, "no veil before 150ms").toBeUndefined();
    await waitFor(() => expect(turn.dataset.pressed).toBe("true"));
    await expect(dialog(canvasElement), "not open before 500ms").toBeNull();
    await waitFor(() => expect(dialog(canvasElement), "held: open").not.toBeNull(), { timeout: 1500 });
    await expect(turn.dataset.pressed, "veil lifts when the details open").toBeUndefined();
    touch(word, "pointerup", x, y);
    (word as HTMLElement).click();
    await expect(args.onWord, "the lift is not a tap on the word").not.toHaveBeenCalled();
    await closeBackTo(canvasElement, stopOf(canvasElement, YOURS));

    // A tap on the uncertain word keeps its own action.
    await userEvent.click(word);
    await expect(args.onWord).toHaveBeenCalledTimes(1);

    // Moving past 10px aborts: a scroll, not a press.
    touch(word, "pointerdown", x, y);
    touch(word, "pointermove", x, y + 11);
    await pause(650);
    await expect(dialog(canvasElement), "moved: aborted").toBeNull();
    await expect(turn.dataset.pressed).toBeUndefined();

    // Within 10px the press holds.
    touch(word, "pointerdown", x, y);
    touch(word, "pointermove", x + 6, y + 6);
    await waitFor(() => expect(dialog(canvasElement), "within slop: open").not.toBeNull(), { timeout: 1500 });
    touch(word, "pointerup", x, y);
    await closeBackTo(canvasElement, stopOf(canvasElement, YOURS));

    // A pointercancel aborts.
    touch(word, "pointerdown", x, y);
    await waitFor(() => expect(turn.dataset.pressed).toBe("true"));
    touch(word, "pointercancel", x, y);
    await waitFor(() => expect(turn.dataset.pressed, "cancel lifts the veil").toBeUndefined());
    await pause(500);
    await expect(dialog(canvasElement), "cancelled: aborted").toBeNull();
  },
});

/** The details open, from a right-click with nothing selected: the existing D54 dialog. */
export const DetailsOpen = meta.story({
  parameters: detailStage,
  name: "Details · open",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    const turn = turnOf(canvasElement, "you");
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    turn.querySelector(".bk-spoken-bubble")!.dispatchEvent(menu);
    await expect(menu.defaultPrevented, "no native menu").toBe(true);
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByRole("heading", { name: "Transcript details" })).toHaveFocus());
    await waitFor(() => expect(body.getByText("Service finish marker received. This does not verify the words or speaker.")).toBeVisible());
    await expect(stopOf(canvasElement, YOURS).getAttribute("aria-expanded")).toBe("true");
  },
});

/** Text selected inside the turn: a right-click passes through to the native menu, so Copy works. */
export const DetailsRightClickSelection = meta.story({
  parameters: detailStage,
  name: "Details · right-click with selection",
  render: DetailTurns,
  play: async ({ canvasElement }) => {
    const prose = turnOf(canvasElement, "brain").querySelector(".bk-spoken-prose")!;
    const text = [...prose.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.includes("twelfth"))!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.indexOf("twelfth"));
    range.setEnd(text, text.textContent!.indexOf("twelfth") + "twelfth".length);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    prose.dispatchEvent(menu);
    await expect(menu.defaultPrevented, "native menu passes through").toBe(false);
    await pause(50);
    await expect(dialog(canvasElement)).toBeNull();
    await expect(getSelection()!.toString()).toBe("twelfth");
  },
});

/** Reduced motion: the pill appears without fading, and the pressed veil is the same static veil. */
export const DetailsReducedMotion = meta.story({
  parameters: detailStage,
  name: "Details · reduced motion",
  render: () => (
    <div data-motion="reduce" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <DetailTurns />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    await userEvent.tab();
    const stop = stopOf(canvasElement, YOURS);
    await expect(stop).toHaveFocus();
    await expect(getComputedStyle(stop).transitionDuration, "no fade").toBe("0s");
    await expect(shown(stop)).toBe(true);
    await reducedMotion(canvasElement);
  },
});
