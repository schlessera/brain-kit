import { expect } from "storybook/test";

import { overflowing } from "../_stage.js";

/** The accessible name a button actually carries: its label or its text. */
function nameOf(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

/**
 * The per-component accessibility the voice surface promises (#3692), measured
 * on the rendered story rather than read off its props:
 *
 *   - every control has an accessible name;
 *   - every state label has an icon AND a word, so no state is colour alone;
 *   - every control's target is at least 44px on both axes (an inline
 *     uncertain word is text, and exempt as inline text is);
 *   - nothing escapes the story's column (except the thinking sweep, which
 *     travels across its meter and is clipped by it, and the contents of the
 *     out-of-sight "Talk live…" button, clipped by its own 1px box).
 */
export async function voiceA11y(root: HTMLElement) {
  for (const button of root.querySelectorAll("button")) {
    await expect(nameOf(button), `named control ${button.outerHTML.slice(0, 80)}`).not.toBe("");
    if (button.classList.contains("bk-uncertain-btn") || button.classList.contains("bk-voice-talk-live")) continue;
    const box = button.getBoundingClientRect();
    await expect(Math.round(box.width), `${nameOf(button)} target width`).toBeGreaterThanOrEqual(44);
    await expect(Math.round(box.height), `${nameOf(button)} target height`).toBeGreaterThanOrEqual(44);
  }
  for (const label of root.querySelectorAll("[data-voice-label]")) {
    await expect(label.querySelector("svg"), "state label has an icon").not.toBeNull();
    await expect(label.querySelector("[data-voice-word]")?.textContent?.trim(), "state label has a word").toBeTruthy();
  }
  await expect(overflowing(root, "*:not(.bk-voice-sweep):not(.bk-voice-talk-live *)")).toEqual([]);
}

/** Heights of every voice field in `root`, in document order. */
export function fieldHeights(root: HTMLElement): number[] {
  return [...root.querySelectorAll<HTMLElement>(".bk-voice-field")].map((f) => f.getBoundingClientRect().height);
}

/**
 * The reduced-motion form, read from computed style: no moving bars (one
 * static level line instead), no sweep (a flat tint), nothing spinning or
 * blinking, a ring without easing and instant shape changes.
 */
export async function reducedMotion(root: HTMLElement) {
  for (const bars of root.querySelectorAll(".bk-voice-bars")) await expect(getComputedStyle(bars).display, "bars hidden").toBe("none");
  for (const line of root.querySelectorAll(".bk-voice-level")) await expect(getComputedStyle(line).display, "static level line shown").toBe("block");
  for (const sweep of root.querySelectorAll(".bk-voice-sweep")) await expect(getComputedStyle(sweep).display, "sweep hidden").toBe("none");
  for (const meter of root.querySelectorAll(".bk-voice-meter[data-mode=sweep]")) await expect(getComputedStyle(meter).backgroundColor, "flat tint").not.toBe("rgba(0, 0, 0, 0)");
  for (const el of root.querySelectorAll(".bk-voice-spin, .bk-voice-ctl-spin, .bk-voice-cursor")) await expect(getComputedStyle(el).animationName, "nothing turns or blinks").toBe("none");
  for (const el of root.querySelectorAll(".bk-voice-ring-fill")) await expect(getComputedStyle(el).transitionDuration, "ring without easing").toBe("0s");
  for (const el of root.querySelectorAll(".bk-voice-field")) await expect(getComputedStyle(el).transitionDuration, "instant shape changes").toBe("0s");
}
