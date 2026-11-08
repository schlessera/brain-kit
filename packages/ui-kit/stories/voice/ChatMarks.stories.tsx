import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { MessageBubble } from "../../src/chrome/MessageBubble.js";
import { ConversationEndDivider, SpokenTurn, UncertainWord, UnplayedText, VoiceToolChip } from "../../src/voice/SpokenTurn.js";
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
