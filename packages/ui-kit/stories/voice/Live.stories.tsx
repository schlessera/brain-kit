import preview from "#.storybook/preview";
import { expect, type within } from "storybook/test";

import { overflowing, stage } from "../_stage.js";
import { enlargedTallFieldHolds, fieldHeights, meterFillsTheCard, reducedMotion, voiceA11y } from "./_checks.js";
import { ENLARGED_IDS, EnlargedText, LIVE_TITLES, Sheet, live, type LiveId } from "./_voice.js";

/**
 * Live conversation, L1–L10 (#3692). The tall field always shows who has the
 * floor: amber while you talk, teal while brain thinks, works or speaks, grey
 * when nothing is heard. Mute, Interrupt and End sit on raised buttons above
 * the meter. Interrupt is live only while brain is speaking (L4).
 *
 * The overlay's other functions live in the field or the chat (#3699, signed
 * off with R1 and R2): a held draft with Send now and Discard draft, Recover
 * reply audio, the refusal line in L6, readiness in L8, the mic-blocked stop,
 * and the coverage line as an inline notice in the chat. The body shows one
 * message at a time. All use the #3692 components unchanged.
 */
const meta = preview.meta({
  title: "Voice/Live",
  decorators: [stage],
});

const IDS: LiveId[] = ["Lc", "L1", "L1d", "L1u", "L1o", "L2", "L3", "L4", "L4d", "L5", "L6", "L7", "L8", "L8r", "L9", "L9m", "L10"];
const TALL: LiveId[] = ["L1", "L1d", "L1u", "L1o", "L2", "L3", "L4", "L4d", "L5", "L6", "L7", "L8", "L8r"];

/** Interrupt is live only while brain is speaking (L4, with or without a draft). */
async function interruptOnlyWhileSpeaking(canvas: ReturnType<typeof within>, id: LiveId) {
  const interrupt = canvas.queryByRole("button", { name: "Interrupt" });
  if (id === "L4" || id === "L4d") {
    // While speaking the control must be there: a missing one is not "live".
    await expect(interrupt, "Interrupt is drawn while speaking").not.toBeNull();
    await expect(interrupt, "Interrupt only while speaking").toBeEnabled();
  } else if (interrupt) await expect(interrupt, "Interrupt only while speaking").toBeDisabled();
}

/** The controls row's accessible names, left to right. */
const controlNames = (root: HTMLElement) => [...root.querySelectorAll(".bk-voice-controls button")].map((b) => b.getAttribute("aria-label"));

/** The field's body line: the one message it shows. */
const bodyText = (root: HTMLElement) => root.querySelector(".bk-voice-body [data-voice-text]")?.textContent?.trim();

/** Your words build in the chat; the field meter is amber. */
export const L1Listening = meta.story({
  name: "L1 Listening",
  render: () => <>{live("L1")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L1");
  },
});
/** A held draft: the words wait in the field, with Send now and Discard draft. No Interrupt (R1). */
export const L1Draft = meta.story({
  name: "L1d Listening · with a draft",
  render: () => <>{live("L1d")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvasElement.querySelector(".bk-voice-label-meta")).toHaveTextContent("Draft · not sent yet");
    await expect(bodyText(canvasElement), "the draft words, with the unsure word named for a screen reader").toBe("Ask Calypso when the axe is back and add it to the tally (uncertain).");
    await expect(canvas.getByRole("button", { name: /tally \(uncertain\)/ }), "an unsure word is marked").toBeVisible();
    await expect(controlNames(canvasElement), "R1: no Interrupt while a draft is held").toEqual(["Mute", "Discard draft", "Send now", "End"]);
  },
});
/** A draft with no confidence to show: the body asks for a review instead. */
export const L1UnclearDraft = meta.story({
  name: "L1u Listening · unclear draft",
  render: () => <>{live("L1u")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(bodyText(canvasElement)).toBe("I couldn’t hear that clearly. Review before sending.");
    await expect(controlNames(canvasElement)).toEqual(["Mute", "Discard draft", "Send now", "End"]);
  },
});
/** After a dropout brain's voice stays paused; replies come as text until you recover it. */
export const L1OutputMuted = meta.story({
  name: "L1o Listening · reply audio off",
  render: () => <>{live("L1o")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvasElement.querySelector(".bk-voice-label-meta")).toHaveTextContent("Reply audio off");
    await expect(bodyText(canvasElement)).toBe("Brain’s voice was paused after a dropout. Replies still arrive as text.");
    await expect(controlNames(canvasElement)).toEqual(["Mute", "Recover reply audio", "End"]);
  },
});
/** A teal sweep crosses the field. */
export const L2Thinking = meta.story({
  name: "L2 Thinking",
  render: () => <>{live("L2")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L2");
  },
});
/** The field says Working; the chip in the chat says what. */
export const L3Working = meta.story({
  name: "L3 Working",
  render: () => <>{live("L3")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L3");
  },
});
/** Brain's voice drives a teal meter. Interrupt is active only now. */
export const L4Speaking = meta.story({
  name: "L4 Speaking",
  render: () => <>{live("L4")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L4");
  },
});
/** Brain is speaking over a held draft: Interrupt stays, so the row carries five controls (R1). */
export const L4Draft = meta.story({
  name: "L4d Speaking · with a draft",
  render: () => <>{live("L4d")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L4d");
    await expect(controlNames(canvasElement), "R1 order").toEqual(["Mute", "Interrupt", "Discard draft", "Send now", "End"]);
  },
});
/** Speaking over brain stops it, and the field goes amber. */
export const L5TalkedOver = meta.story({
  name: "L5 Talked over",
  render: () => <>{live("L5")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L5");
  },
});
/**
 * Approvals are tap-only cards; the field turns neutral and outlined until you
 * answer, and its body says why voice cannot answer them.
 */
export const L6NeedsYourTap = meta.story({
  name: "L6 Needs your tap",
  render: () => <>{live("L6")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L6");
    await expect(bodyText(canvasElement)).toBe("Tap Allow or Deny on the card. Voice can’t approve or refuse with this service.");
    await expect(controlNames(canvasElement)).toEqual(["Mute", "Interrupt", "End"]);
  },
});
/** Grey and flat, with Mute solid. Brain may finish its sentence (V5). */
export const L7Muted = meta.story({
  name: "L7 Muted",
  render: () => <>{live("L7")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L7");
  },
});
/** Striped and paused; the timer holds. Recovering returns to Listening. */
export const L8Reconnecting = meta.story({
  name: "L8 Reconnecting",
  render: () => <>{live("L8")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L8");
  },
});
/** Voice is not ready yet: the mic is off and nothing is heard until it is. */
export const L8Readiness = meta.story({
  name: "L8r Reconnecting · readiness",
  render: () => <>{live("L8r")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L8r");
    await expect(canvasElement.querySelector(".bk-voice-label-meta")).toHaveTextContent("mic off");
    await expect(bodyText(canvasElement)).toBe("Waiting for voice to be ready. Nothing is heard until then.");
    await expect(canvas.getByRole("button", { name: "Mute" }), "Mute waits for readiness").toBeDisabled();
    await expect(controlNames(canvasElement)).toEqual(["Mute", "Interrupt", "End"]);
  },
});
/** Only when recovery fails. Start again goes straight back to the Start card. */
export const L9Stopped = meta.story({
  name: "L9 Stopped",
  render: () => <>{live("L9")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L9");
  },
});
/** The browser blocked the microphone mid-conversation. */
export const L9MicBlocked = meta.story({
  name: "L9m Stopped · mic blocked",
  render: () => <>{live("L9m")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvasElement).toHaveTextContent("Microphone is blocked. Allow it in this site’s browser settings, then Start again.");
    await expect(canvas.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "Start again"]);
  },
});
/** End returns the plain composer; a divider marks the conversation in the chat. */
export const L10Ended = meta.story({
  name: "L10 Ended",
  render: () => <>{live("L10")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L10");
  },
});

/** What startup context covered, inline in the chat at the start of the live section (R2). */
export const LcCoverage = meta.story({
  name: "Lc Coverage · inline in the chat",
  render: () => <>{live("Lc")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvasElement).toHaveTextContent("Started with the last 12 messages · Details");
    await expect(canvas.getByRole("button", { name: "Prior context details" })).toBeVisible();
    await expect(canvasElement.querySelector(".bk-voice-field"), "not a line on the Start card or the field").toBeNull();
  },
});

/**
 * The five-control row fits a 320px column: L4 with a draft (R1) keeps every
 * control whole, 44px, inside the field and in order.
 */
export const FiveControlsAt320 = meta.story({
  parameters: { stageWidth: 320 },
  render: () => <>{live("L4d")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    const field = canvasElement.querySelector<HTMLElement>(".bk-voice-field")!;
    const box = field.getBoundingClientRect();
    await expect(box.width, "a 320px column").toBeLessThanOrEqual(320);
    await expect(box.height, "the tall field's height").toBe(136);
    const buttons = [...field.querySelectorAll<HTMLElement>(".bk-voice-controls button")];
    await expect(controlNames(canvasElement)).toEqual(["Mute", "Interrupt", "Discard draft", "Send now", "End"]);
    const row = field.querySelector<HTMLElement>(".bk-voice-controls")!;
    await expect(row.scrollWidth, "the row does not overflow").toBeLessThanOrEqual(row.clientWidth);
    let previousRight = -Infinity;
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      await expect(r.left, `${b.getAttribute("aria-label")} inside the field`).toBeGreaterThanOrEqual(box.left);
      await expect(r.right, `${b.getAttribute("aria-label")} inside the field`).toBeLessThanOrEqual(box.right);
      await expect(r.left, `${b.getAttribute("aria-label")} on one row, after its neighbour`).toBeGreaterThanOrEqual(previousRight);
      previousRight = r.right;
    }
    const tops = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
    await expect(tops.size, "one row").toBe(1);
  },
});

/** Every live state, for review and the baselines. */
export const AllStates = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={LIVE_TITLES} render={live} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(17);
    await voiceA11y(canvasElement);
    // L1–L5, L7, L8 and the five overlay forms from #3738 (drafts, notices, recovery).
    await expect(await meterFillsTheCard(canvasElement), "every tall state with a meter").toBe(12);
  },
});

/**
 * The tall field is one height from L1 to L8, with a draft, a body line or five
 * controls: who has the floor never moves the chat.
 */
export const HeightIsStable = meta.story({
  render: () => <>{TALL.map((id) => <div key={id} style={{ width: "100%" }}>{live(id)}</div>)}</>,
  play: async ({ canvasElement }) => {
    const heights = fieldHeights(canvasElement);
    await expect(heights).toHaveLength(13);
    await expect(heights[0], "L1 height").toBe(136);
    for (const [i, h] of heights.entries()) await expect(h, `${TALL[i]} is L1's height`).toBe(heights[0]);
  },
});

async function enlargedPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(5);
  await expect(await enlargedTallFieldHolds(canvasElement), "L1d, L4d, L6 and L1o carry a body").toBe(4);
  await expect(overflowing(canvasElement, "*:not(.bk-voice-sweep)")).toEqual([]);
}

/**
 * The tall field under 200% text (#3773, R1 and R2): with a body it grows to
 * its content, upward, with the controls pinned to its bottom. The label
 * wraps instead of cutting off its meta, a draft keeps its newest two whole
 * lines and a message shows whole. Without a body it stays 136px.
 */
export const TallFieldEnlargedText = meta.story({
  name: "Tall field · enlarged text",
  parameters: { stageWidth: "none" },
  render: () => (
    <EnlargedText>
      <Sheet ids={ENLARGED_IDS} titles={LIVE_TITLES} render={live} />
    </EnlargedText>
  ),
  play: enlargedPlay,
});

/** The same states in a 320px column, where the label wraps and a message runs past two lines. */
export const TallFieldEnlargedTextAt320 = meta.story({
  name: "Tall field · enlarged text · 320",
  parameters: { stageWidth: 320 },
  render: () => (
    <EnlargedText>
      <Sheet ids={ENLARGED_IDS} titles={LIVE_TITLES} render={live} />
    </EnlargedText>
  ),
  play: enlargedPlay,
});

/** Reduced motion: static level lines, flat tints, nothing turning. */
export const ReducedMotion = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={LIVE_TITLES} render={live} motion="reduce" />,
  play: async ({ canvasElement }) => {
    await reducedMotion(canvasElement);
    await voiceA11y(canvasElement);
  },
});
