// Shared furniture for the Gmail stories (#4209): the two widths every state
// is drawn at, and the assertions every story makes at both, in both themes.

import { expect } from "storybook/test";

import { viewportAt } from "../_viewports.js";

/** A phone: the 320px viewport, so width media queries answer as they would on one. */
export const narrow = { globals: viewportAt(320), parameters: { stageWidth: "none" } };

/** The design's desktop card width. */
export const desktop = { parameters: { stageWidth: 680 } };

/** A control's reachable box: its own, or its `::before` reach for an inline text control. */
export function reach(control: HTMLElement): { width: number; height: number } {
  const box = control.getBoundingClientRect();
  const before = getComputedStyle(control, "::before");
  if (before.content !== "none" && before.position === "absolute") {
    return { width: box.width - 2 * parseFloat(before.left), height: box.height - 2 * parseFloat(before.top) };
  }
  return { width: box.width, height: box.height };
}

/**
 * Every control in `root` that is not a full target, by name and size: its
 * box must be at least 24px each way (WCAG 2.5.8, the fine-pointer floor the
 * story projects run under), and it must reach 44px on touch — a box 44px
 * tall, the inline text control's 44px `::before`, or `.bk-hit` (`Button`'s
 * `reach`), which reaches 44px under a coarse pointer. Links inside
 * untrusted prose take 2.5.8's inline exception.
 */
export function smallTargets(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const control of root.querySelectorAll<HTMLElement>("button, [role='button'], a[href]")) {
    if (control.matches("[data-untrusted-link]") || control.closest("[hidden]")) continue;
    const r = reach(control);
    const touch = r.height >= 44 - 0.5 || control.classList.contains("bk-hit");
    if (r.height < 24 - 0.5 || r.width < 24 - 0.5 || !touch) {
      out.push(`${control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40)}: ${Math.round(r.width)}×${Math.round(r.height)}${touch ? "" : ", no 44px touch reach"}`);
    }
  }
  return out;
}

/**
 * Every element whose VISIBLE part escapes `root`, as sentences. Like
 * `overflowing` in `_stage.tsx`, but an element clipped by an `overflow`
 * ancestor inside the card (an ellipsis, the loading ghost's sliding track)
 * counts only for what shows. The card's own scroll width is checked too.
 */
export function escapes(root: HTMLElement): string[] {
  const box = root.getBoundingClientRect();
  const out: string[] = [];
  if (root.scrollWidth > root.clientWidth + 1) out.push(`content is ${root.scrollWidth}px wide inside a ${root.clientWidth}px box`);
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if ((el as unknown as { ownerSVGElement?: unknown }).ownerSVGElement) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    let left = rect.left;
    let right = rect.right;
    for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === "visible") continue;
      const clip = a.getBoundingClientRect();
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (right <= left) continue;
    const name = `<${el.tagName.toLowerCase()}>${(el.textContent ?? "").trim().slice(0, 24)}`;
    if (right > box.right + 1) out.push(`${name} shows ${Math.round(right - box.right)}px past the right edge`);
    if (left < box.left - 1) out.push(`${name} shows ${Math.round(box.left - left)}px past the left edge`);
  }
  return out;
}

/** The card the story drew. */
export const card = (canvasElement: HTMLElement) => canvasElement.querySelector<HTMLElement>("[data-gmail-results], [data-gmail-thread], [data-gmail-message], [data-gmail-labels]")!;

/**
 * What every Gmail story asserts, at its width and in its theme: it drew at
 * that width, nothing escapes the card, and every control is a full target.
 */
export async function holdsTogether(canvasElement: HTMLElement, width: "narrow" | "desktop") {
  const root = card(canvasElement);
  await expect(root, "the story drew its component").not.toBeNull();
  if (width === "narrow") {
    await expect(window.innerWidth, "the phone story runs at the 320px viewport").toBe(320);
  } else {
    const column = canvasElement.firstElementChild as HTMLElement;
    await expect(column.getBoundingClientRect().width, "the desktop story draws in the 680px column").toBe(680);
    if (!root.matches("[data-gmail-labels]")) await expect(root.getBoundingClientRect().width, "the card fills its column").toBeGreaterThan(660);
  }
  await expect(escapes(root), "nothing escapes the card").toEqual([]);
  await expect(smallTargets(root), "every control is a 24px box with a 44px touch target").toEqual([]);
}

/** The width a story is drawn at, from its own parameters. */
export const widthOf = (parameters: Record<string, unknown>): "narrow" | "desktop" => (parameters.stageWidth === "none" ? "narrow" : "desktop");

/** Every text node of `root` holding one of `needles` that is not inside an untrusted field or text block. */
export function unguarded(root: HTMLElement, needles: string[]): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (const needle of needles) {
      if (value.includes(needle) && !node.parentElement?.closest("[data-untrusted-field], [data-untrusted-text]")) out.push(needle);
    }
  }
  return out;
}
