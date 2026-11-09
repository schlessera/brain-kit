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
 * The disclosure forms (#3694, signed off with K1 and K2) name where the words
 * go before any audio leaves the browser: the first-take acknowledgement (D0),
 * a grey Connecting field (Dc), the destination as D3–D5's meta, and the two
 * notices for a missing service (Dx). All use the #3692 components unchanged.
 *
 * The field keeps the composer's height at rest (D1, D6) and one fixed height
 * while a state label shows (D3–D5), so listening never moves the page:
 * `HeightIsStable` measures it.
 */
const meta = preview.meta({
  title: "Voice/Dictation",
  decorators: [stage],
});

const IDS: DictationId[] = ["D0", "D1", "D2", "Dc", "D3", "D3b", "D4", "D5", "D6", "D7", "D8", "Dx1", "Dx2"];

/** The accessible names of every button in `root`, in document order. */
const buttonNames = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim());

/** First take only: the destination is named before any session request or mic access. */
export const D0FirstTake = meta.story({
  name: "D0 First take · acknowledgement",
  render: () => <>{dictation("D0")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("status"), "announced politely").toHaveTextContent("Your words are sent to Google Gemini to be written down. The audio isn’t kept.");
    await expect(buttonNames(canvasElement)).toEqual(["Cancel", "Start dictation"]);
    await expect(canvas.getByRole("button", { name: "Start dictation" }), "K1: initial focus on Start dictation").toHaveFocus();
  },
});

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
/** Grey while the service connects: nothing is heard yet, so it never says Listening. */
export const DcConnecting = meta.story({
  name: "Dc Connecting · mic not open",
  render: () => <>{dictation("Dc")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    const field = canvasElement.querySelector<HTMLElement>(".bk-voice-field")!;
    await expect(field.dataset.tone, "grey").toBe("idle");
    await expect(field, "never says Listening before the mic is open").not.toHaveTextContent("Listening");
    await expect(field).toHaveTextContent("Not listening yet");
    await expect(field.querySelector(".bk-voice-label-meta"), "the destination is named").toHaveTextContent("to Google Gemini");
    await expect(buttonNames(canvasElement)).toEqual(["Cancel dictation"]);
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
/** Browser speech outside Chrome: the browser decides where audio goes (K2). */
export const D3BrowserSpeech = meta.story({
  name: "D3b Listening · browser speech, not Chrome",
  render: () => <>{dictation("D3b")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvasElement.querySelector(".bk-voice-label-meta")).toHaveTextContent("browser speech · sent by your browser");
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

/** No service is chosen: no mic and no meter, only the way to Settings. */
export const DxNoService = meta.story({
  name: "Dx1 No dictation service",
  render: () => <>{dictation("Dx1")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(buttonNames(canvasElement)).toEqual(["Cancel", "Open Settings"]);
    await expect(canvasElement.querySelector(".bk-voice-meter"), "no meter").toBeNull();
  },
});
/** The saved service is no longer offered here. */
export const DxServiceGone = meta.story({
  name: "Dx2 Saved service gone",
  render: () => <>{dictation("Dx2")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(buttonNames(canvasElement)).toEqual(["Cancel", "Open Settings"]);
    await expect(canvasElement.querySelector(".bk-voice-meter"), "no meter").toBeNull();
  },
});

/** Every dictation state, for review against the mockup sheet and for the baselines. */
export const AllStates = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={DICTATION_TITLES} render={dictation} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(13);
    await voiceA11y(canvasElement);
  },
});

/**
 * The field is one height across Dc, D3, D4 and D5, with or without a long
 * destination, and the composer's own 52px at rest: a state change never moves
 * the transcript above it.
 */
export const HeightIsStable = meta.story({
  render: () => <>{(["D3", "D4", "D5", "D1", "Dc", "D3b"] as const).map((id) => <div key={id} style={{ width: "100%" }}>{dictation(id)}</div>)}</>,
  play: async ({ canvasElement }) => {
    const [d3, d4, d5, d1, dc, d3b] = fieldHeights(canvasElement);
    await expect(d3, "D3 height").toBe(84);
    await expect(d4, "D4 is D3's height").toBe(d3);
    await expect(d5, "D5 is D3's height").toBe(d3);
    await expect(d1, "rest is the composer's height").toBe(52);
    await expect(dc, "Dc is D3's height").toBe(d3);
    await expect(d3b, "a long destination keeps D3's height").toBe(d3);
  },
});

/**
 * At 320px the longest destination stays on one line: the meta ellipsizes
 * first and the state word never does.
 */
export const LongDestinationAt320 = meta.story({
  parameters: { stageWidth: 320 },
  render: () => <>{dictation("D3b")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    const field = canvasElement.querySelector<HTMLElement>(".bk-voice-field")!;
    await expect(field.getBoundingClientRect().width, "a 320px column").toBeLessThanOrEqual(320);
    await expect(fieldHeights(canvasElement), "84px kept").toEqual([84]);
    const metaLine = field.querySelector<HTMLElement>(".bk-voice-label-meta")!;
    const word = field.querySelector<HTMLElement>("[data-voice-word]")!;
    await expect(metaLine.scrollWidth, "the meta ellipsizes").toBeGreaterThan(metaLine.clientWidth);
    await expect(getComputedStyle(metaLine).textOverflow).toBe("ellipsis");
    await expect(word.scrollWidth, "the word is whole").toBeLessThanOrEqual(word.clientWidth);
    await expect(metaLine.getBoundingClientRect().height, "one line").toBeLessThanOrEqual(16);
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
