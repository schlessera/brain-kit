import preview from "#.storybook/preview";
import { expect, type within } from "storybook/test";

import { stage } from "../_stage.js";
import { fieldHeights, reducedMotion, voiceA11y } from "./_checks.js";
import { LIVE_TITLES, Sheet, live, type LiveId } from "./_voice.js";

/**
 * Live conversation, L1–L10 (#3692). The tall field always shows who has the
 * floor: amber while you talk, teal while brain thinks, works or speaks, grey
 * when nothing is heard. Mute, Interrupt and End sit on raised buttons above
 * the meter. Interrupt is live only while brain is speaking (L4).
 */
const meta = preview.meta({
  title: "Voice/Live",
  decorators: [stage],
});

const IDS: LiveId[] = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
const TALL: LiveId[] = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];

/** Interrupt is live only while brain is speaking (L4). */
async function interruptOnlyWhileSpeaking(canvas: ReturnType<typeof within>, id: LiveId) {
  const interrupt = canvas.queryByRole("button", { name: "Interrupt" });
  if (!interrupt) return;
  if (id === "L4") await expect(interrupt, "Interrupt only while speaking").toBeEnabled();
  else await expect(interrupt, "Interrupt only while speaking").toBeDisabled();
}

/** Your words build in the chat; the field meter is amber. */
export const L1Listening = meta.story({
  name: "L1 Listening",
  render: () => <>{live("L1")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L1");
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
/** Speaking over brain stops it, and the field goes amber. */
export const L5TalkedOver = meta.story({
  name: "L5 Talked over",
  render: () => <>{live("L5")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L5");
  },
});
/** Approvals are tap-only cards; the field turns neutral and outlined until you answer. */
export const L6NeedsYourTap = meta.story({
  name: "L6 Needs your tap",
  render: () => <>{live("L6")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L6");
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
/** Only when recovery fails. Start again goes straight back to the Start card. */
export const L9Stopped = meta.story({
  name: "L9 Stopped",
  render: () => <>{live("L9")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await interruptOnlyWhileSpeaking(canvas, "L9");
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

/** Every live state, for review and the baselines. */
export const AllStates = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={LIVE_TITLES} render={live} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(10);
    await voiceA11y(canvasElement);
  },
});

/** The tall field is one height from L1 to L8: who has the floor never moves the chat. */
export const HeightIsStable = meta.story({
  render: () => <>{TALL.map((id) => <div key={id} style={{ width: "100%" }}>{live(id)}</div>)}</>,
  play: async ({ canvasElement }) => {
    const heights = fieldHeights(canvasElement);
    await expect(heights).toHaveLength(8);
    await expect(heights[0], "L1 height").toBe(136);
    for (const [i, h] of heights.entries()) await expect(h, `${TALL[i]} is L1's height`).toBe(heights[0]);
  },
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
