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
 *   - the state label's word and meta sit on the field's own opaque ground, so
 *     a meter bar never lies under a glyph (#3746);
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
  for (const text of root.querySelectorAll("[data-voice-word], .bk-voice-label-meta")) {
    const field = text.closest(".bk-voice-field");
    if (!field) continue;
    // The field eases its fill (120ms); a theme switch just before a story
    // would otherwise be read mid-transition.
    await Promise.all(field.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await expect(getComputedStyle(text).backgroundColor, `${text.textContent} sits on the field's ground`).toBe(getComputedStyle(field).backgroundColor);
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

/**
 * The meter fills the whole card (#3746): in every field with a meter, the
 * meter layer's box is the field's padding box, so the sweep, hatch, flat
 * line and bars reach every edge.
 */
export async function meterFillsTheCard(root: HTMLElement) {
  const fields = [...root.querySelectorAll<HTMLElement>(".bk-voice-field")].filter((f) => f.querySelector(":scope > .bk-voice-meter"));
  for (const field of fields) {
    const meter = field.querySelector<HTMLElement>(":scope > .bk-voice-meter")!.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    const inset = { x: field.clientLeft, y: field.clientTop };
    const label = field.querySelector("[data-voice-word]")?.textContent ?? field.dataset.shape;
    await expect([meter.top - box.top, box.bottom - meter.bottom, meter.left - box.left, box.right - meter.right].map((n) => Math.round(n * 10) / 10), `${label} meter fills the card`)
      .toEqual([inset.y, inset.y, inset.x, inset.x]);
  }
  return fields.length;
}
