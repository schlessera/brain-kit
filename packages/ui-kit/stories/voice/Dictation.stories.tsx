import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { stage } from "../_stage.js";
import { fieldHeights, reducedMotion, voiceA11y } from "./_checks.js";
import { DICTATION_TITLES, Sheet, dictation, type DictationId } from "./_voice.js";

/**
 * Dictation, D1–D8 (#3692, direction 3a on #3690). A tap on the composer mic
 * fills the field amber and the words land in it. Nothing is sent until you
 * choose to; every exit leaves the text in the field for review.
 *
 * The field keeps the composer's height at rest (D1, D6) and one fixed height
 * while a state label shows (D3–D5), so listening never moves the page:
 * `HeightIsStable` measures it.
 */
const meta = preview.meta({
  title: "Voice/Dictation",
  decorators: [stage],
});

const IDS: DictationId[] = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];

/** The mic sits in the composer, with no labels and no extra buttons. */
export const D1Ready = meta.story({
  name: "D1 Ready",
  render: () => <>{dictation("D1")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});
/** First use only: the field waits on the browser's prompt. Cancel returns to D1. */
export const D2WaitingForAccess = meta.story({
  name: "D2 First use · waiting for access",
  render: () => <>{dictation("D2")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});
/** The meter follows your voice; unconfirmed words stay muted until they settle. */
export const D3Listening = meta.story({
  name: "D3 Listening",
  render: () => <>{dictation("D3")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});
/** No speech: the meter lies flat and a hint appears. After 30 s of silence it stops by itself (V3). */
export const D4Quiet = meta.story({
  name: "D4 Listening · quiet",
  render: () => <>{dictation("D4")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});
/** After ✓, a short amber sweep while the last words are confirmed; the ✓ shows progress. */
export const D5Finishing = meta.story({
  name: "D5 Finishing",
  render: () => <>{dictation("D5")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});
/** Back to a normal composer with Send. An unsure word is dotted; tap it for alternatives. */
export const D6Review = meta.story({
  name: "D6 Review",
  render: () => <>{dictation("D6")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    const word = canvas.getByRole("button", { name: /sail \(uncertain\)/ });
    await expect(getComputedStyle(word.firstElementChild!).textDecorationStyle, "dotted underline").toBe("dotted");
  },
});
/** Plain words and one action. No error codes. Tapping the mic again retries. */
export const D7MicBlocked = meta.story({
  name: "D7 Mic blocked",
  render: () => <>{dictation("D7")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});
/** Anything already heard is kept in the composer. Try again carries on from it. */
export const D8Stopped = meta.story({
  name: "D8 Dictation stopped",
  render: () => <>{dictation("D8")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});

/** Every dictation state, for review against the mockup sheet and for the baselines. */
export const AllStates = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={DICTATION_TITLES} render={dictation} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(8);
    await voiceA11y(canvasElement);
  },
});

/**
 * The field is one height across D3, D4 and D5, and the composer's own 52px at
 * rest: a state change never moves the transcript above it.
 */
export const HeightIsStable = meta.story({
  render: () => <>{(["D3", "D4", "D5", "D1"] as const).map((id) => <div key={id} style={{ width: "100%" }}>{dictation(id)}</div>)}</>,
  play: async ({ canvasElement }) => {
    const [d3, d4, d5, d1] = fieldHeights(canvasElement);
    await expect(d3, "D3 height").toBe(84);
    await expect(d4, "D4 is D3's height").toBe(d3);
    await expect(d5, "D5 is D3's height").toBe(d3);
    await expect(d1, "rest is the composer's height").toBe(52);
  },
});

/** Reduced motion: one static level line, a flat tint for the sweep, a still ✓. */
export const ReducedMotion = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={DICTATION_TITLES} render={dictation} motion="reduce" />,
  play: async ({ canvasElement }) => {
    await reducedMotion(canvasElement);
    await voiceA11y(canvasElement);
  },
});
