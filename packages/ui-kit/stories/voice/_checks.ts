import { expect } from "storybook/test";

import { overflowing } from "../_stage.js";

/** The accessible name a button actually carries: its label or its text. */
function nameOf(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

/**
 * A control's hit area. An inline text button paints at text size and takes
 * its 44px target from a `::before` with negative insets, so that pseudo's
 * computed insets are added to the box.
 */
function targetOf(button: HTMLElement): { width: number; height: number } {
  const box = button.getBoundingClientRect();
  if (!button.matches(".bk-text-btn[data-inline=true]")) return box;
  const before = getComputedStyle(button, "::before");
  const out = (side: string) => Math.max(0, -parseFloat(before.getPropertyValue(side)) || 0);
  return { width: box.width + out("left") + out("right"), height: box.height + out("top") + out("bottom") };
}

/**
 * The per-component accessibility the voice surface promises (#3692), measured
 * on the rendered story rather than read off its props:
 *
 *   - every control has an accessible name;
 *   - every state label has an icon AND a word, so no state is colour alone;
 *   - every control's target is at least 44px on both axes (an inline
 *     uncertain word is text, and exempt as inline text is; an inline text
 *     button's target is its box plus the `::before` that extends it);
 *   - text in the field has no background of its own; it carries a halo in the
 *     field's ground, and the tall label row sits in the meter's solid top
 *     fade (#3746);
 *   - nothing escapes the story's column (except the thinking sweep, which
 *     travels across its meter and is clipped by it, and the contents of the
 *     out-of-sight "Talk live…" button, clipped by its own 1px box).
 */
export async function voiceA11y(root: HTMLElement) {
  for (const button of root.querySelectorAll<HTMLElement>("button")) {
    await expect(nameOf(button), `named control ${button.outerHTML.slice(0, 80)}`).not.toBe("");
    if (button.classList.contains("bk-uncertain-btn") || button.classList.contains("bk-voice-talk-live")) continue;
    const box = targetOf(button);
    await expect(Math.round(box.width), `${nameOf(button)} target width`).toBeGreaterThanOrEqual(44);
    await expect(Math.round(box.height), `${nameOf(button)} target height`).toBeGreaterThanOrEqual(44);
  }
  for (const label of root.querySelectorAll("[data-voice-label]")) {
    await expect(label.querySelector("svg"), "state label has an icon").not.toBeNull();
    await expect(label.querySelector("[data-voice-word]")?.textContent?.trim(), "state label has a word").toBeTruthy();
  }
  for (const text of root.querySelectorAll<HTMLElement>("[data-voice-word], .bk-voice-label-meta, .bk-voice-text")) {
    const field = text.closest<HTMLElement>(".bk-voice-field");
    if (!field) continue;
    const name = text.textContent?.trim().slice(0, 24);
    await expect(getComputedStyle(text).backgroundColor, `${name}: no text background`).toBe("rgba(0, 0, 0, 0)");
    for (const inner of text.querySelectorAll("span")) await expect(getComputedStyle(inner).backgroundColor, `${name}: no text background`).toBe("rgba(0, 0, 0, 0)");
    await expect(getComputedStyle(text).textShadow, `${name}: halo in the field's ground`).not.toBe("none");
    const meter = field.querySelector(":scope > .bk-voice-meter");
    if (field.dataset.shape === "tall" && meter && !text.matches(".bk-voice-text")) {
      // The tall label row sits in the meter's solid top fade.
      await expect(getComputedStyle(meter, "::after").backgroundImage, `${name}: in the top fade`).toContain("linear-gradient");
      await expect(text.getBoundingClientRect().bottom, `${name}: within the fade's solid band`).toBeLessThanOrEqual(meter.getBoundingClientRect().top + 28);
    }
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

/**
 * The tall field under enlarged text (#3773): it grows to hold everything and
 * hides nothing. In every tall field in `root`:
 *
 *   - the text really is doubled (the label at 24px), so the checks below
 *     could fail;
 *   - nothing paints below the field (`scrollHeight <= clientHeight`), and
 *     every control sits inside the field's box, at least 44px;
 *   - nothing in the label is ellipsised: the word and the meta show whole;
 *   - the body shows whole lines: words keep at most two (the newest), and a
 *     message (the refusal line, a notice) shows whole (R1);
 *   - a field with a body grows past 136px, and one without stays 136px.
 *
 * Returns how many fields carried a body, so a story can check the cells it
 * meant to test were there.
 */
export async function enlargedTallFieldHolds(root: HTMLElement) {
  let bodies = 0;
  for (const field of root.querySelectorAll<HTMLElement>('.bk-voice-field[data-shape="tall"]')) {
    const label = field.querySelector<HTMLElement>("[data-voice-label]")!;
    const name = label.querySelector("[data-voice-word]")?.textContent ?? "field";
    const box = field.getBoundingClientRect();
    await expect(getComputedStyle(label).fontSize, `${name}: the label is at 200% text`).toBe("24px");
    await expect(field.scrollHeight, `${name}: nothing paints below the field`).toBeLessThanOrEqual(field.clientHeight);
    for (const button of field.querySelectorAll<HTMLElement>(".bk-voice-controls button")) {
      const r = button.getBoundingClientRect();
      const what = `${name}: ${button.getAttribute("aria-label")}`;
      await expect(r.top, `${what} inside the field`).toBeGreaterThanOrEqual(box.top);
      await expect(r.bottom, `${what} inside the field`).toBeLessThanOrEqual(box.bottom);
      await expect(r.left, `${what} inside the field`).toBeGreaterThanOrEqual(box.left);
      await expect(r.right, `${what} inside the field`).toBeLessThanOrEqual(box.right);
      await expect(Math.round(r.height), `${what} keeps its 44px target`).toBeGreaterThanOrEqual(44);
    }
    for (const part of label.children) {
      await expect(part.scrollWidth, `${name}: "${part.textContent}" is not ellipsised`).toBeLessThanOrEqual(part.clientWidth);
    }
    const text = field.querySelector<HTMLElement>(".bk-voice-body [data-voice-text]");
    if (!text) {
      await expect(box.height, `${name}: without a body the field stays 136px`).toBe(136);
      continue;
    }
    bodies++;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    const lines = text.getBoundingClientRect().height / lineHeight;
    await expect(Math.abs(lines - Math.round(lines)), `${name}: the body shows whole lines (${lines.toFixed(2)})`).toBeLessThan(0.05);
    if (text.dataset.voiceText === "message") {
      // The box is bottom-aligned, so a clamped message overflows at the top,
      // which scrollHeight does not count: compare the content's own height.
      const content = text.firstElementChild!.getBoundingClientRect().height;
      await expect(content, `${name}: a message shows whole`).toBeLessThanOrEqual(text.getBoundingClientRect().height + 0.5);
    } else {
      await expect(Math.round(lines), `${name}: words keep the newest two lines`).toBeLessThanOrEqual(2);
    }
    await expect(box.height, `${name}: the field grows for its body`).toBeGreaterThan(136);
  }
  return bodies;
}
