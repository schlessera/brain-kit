import preview from "#.storybook/preview";
import { expect, userEvent } from "storybook/test";

import { stage } from "../_stage.js";
import { reducedMotion, voiceA11y } from "./_checks.js";
import { START_TITLES, Sheet, start, type StartId } from "./_voice.js";

/**
 * Starting live, S1–S5 (#3692). Holding the mic turns it teal and fills a
 * ring (0.6 s, V1). When the ring closes the field opens into the Start card:
 * one line on what is shared, the Service row with Change (#3616 L1), the
 * persona list (#3617) and one Start button. × or a swipe down cancels.
 *
 * S3b–S3d are the recovery cases (#3616 L2, #3617 P2/P3): none silently
 * substitutes a service or a voice, and the blocking ones keep Start
 * unavailable until the user acts.
 */
const meta = preview.meta({
  title: "Voice/Start",
  decorators: [stage],
});

const IDS: StartId[] = ["S1", "S2", "S2+", "S3", "S3b", "S3c", "S3d", "S4", "S5"];

/** Nothing is recorded during the hold. Releasing early counts as a tap. */
export const S1Holding = meta.story({
  name: "S1 Holding",
  render: () => <>{start("S1")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    const ring = document.querySelector(".bk-voice-ring")!;
    await expect(ring.getAttribute("data-progress"), "ring drawn from progress").toBe("0.6");
  },
});

/** One usable service: no Change. The last persona is preselected. */
export const S2StartCard = meta.story({
  name: "S2 Start card · one service",
  render: () => <>{start("S2")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.queryByRole("button", { name: /Change service/ }), "no Change with one service").toBeNull();
    await expect(canvas.getByRole("radio", { name: /Ithaca steward/ })).toHaveAttribute("aria-checked", "true");
    const shared = canvas.getByRole("button", { name: /What’s shared/ });
    // Close under Start, with its full 44px target (#3746).
    const start = canvas.getByRole("button", { name: "Start" }).getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(shared);
    await expect(Math.round(text.getBoundingClientRect().top - start.bottom), "What’s shared sits close under Start").toBeLessThanOrEqual(16);
    await expect(shared.getBoundingClientRect().height, "44px target kept").toBeGreaterThanOrEqual(44);
    await expect(shared.getBoundingClientRect().top, "target clear of Start").toBeGreaterThanOrEqual(start.bottom);
    await userEvent.click(shared);
    await expect(shared).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(/Audio is not saved/)).toBeVisible();
  },
});

/** Several usable services: Change applies to this conversation only. */
export const S2SeveralServices = meta.story({
  name: "S2+ Start card · several services",
  render: () => <>{start("S2+")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Change service, now Gemini Live" })).toBeVisible();
  },
});

/** Disclosed rather than silently swapped: the default voice is named. Start stays enabled. */
export const S3DefaultVoice = meta.story({
  name: "S3 Persona has no voice here",
  render: () => <>{start("S3")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Start" })).not.toHaveAttribute("aria-disabled");
    await expect(canvas.getByText(/default voice \(Kore\)/)).toBeVisible();
  },
});

/** A saved voice that is invalid or stale needs visible recovery. */
export const S3bStaleVoice = meta.story({
  name: "S3b Saved voice is stale",
  render: () => <>{start("S3b")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Start" })).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByRole("button", { name: "Choose a voice" })).toBeVisible();
  },
});

/** Instructions over the service's byte cap block Start. */
export const S3cOverCap = meta.story({
  name: "S3c Instructions over the cap",
  render: () => <>{start("S3c")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Start" })).toHaveAttribute("aria-disabled", "true");
  },
});

/** The saved service is unavailable: an explicit pick is required. */
export const S3dServiceUnavailable = meta.story({
  name: "S3d Saved service unavailable",
  render: () => <>{start("S3d")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Start" })).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByRole("button", { name: "Choose a service" })).toBeVisible();
  },
});

/** The ring still fills, then explains instead of opening Start (V4). Dictation stays one tap away. */
export const S4NotSetUp = meta.story({
  name: "S4 Live not available",
  render: () => <>{start("S4")}</>,
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
  },
});

/** The field takes its live shape straight away. Mute and Interrupt stay dim until connected; End works at once. */
export const S5Connecting = meta.story({
  name: "S5 Connecting",
  render: () => <>{start("S5")}</>,
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Mute" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "End" })).toBeEnabled();
  },
});

/** The persona list is one radio group: arrow keys move, and selection follows. */
export const PersonaKeyboard = meta.story({
  render: () => <>{start("S2")}</>,
  play: async ({ canvas }) => {
    const steward = canvas.getByRole("radio", { name: /Ithaca steward/ });
    await expect(steward).toHaveAttribute("tabindex", "0");
    await expect(canvas.getByRole("radio", { name: /Standard/ })).toHaveAttribute("tabindex", "-1");
    // The arrow keys move through the group and wrap at either end.
    steward.focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("radio", { name: /Harbour storyteller/ }), "ArrowDown moves to the next persona").toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("radio", { name: /Standard/ }), "ArrowDown wraps to the first").toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect(canvas.getByRole("radio", { name: /Harbour storyteller/ }), "ArrowUp wraps to the last").toHaveFocus();
  },
});

/** Every Start state, for review and the baselines. */
export const AllStates = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={START_TITLES} render={start} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(9);
    await voiceA11y(canvasElement);
  },
});

/** Reduced motion: the ring shows progress without easing; Connecting does not turn. */
export const ReducedMotion = meta.story({
  parameters: { stageWidth: "none" },
  render: () => <Sheet ids={IDS} titles={START_TITLES} render={start} motion="reduce" />,
  play: async ({ canvasElement }) => {
    await reducedMotion(canvasElement);
    await voiceA11y(canvasElement);
  },
});
