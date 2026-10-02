/// <reference types="@vitest/browser-playwright" />
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { AskUserRankCard } from "../../src/decisions/AskUserRankCard.js";
import { rankingJourneys } from "../../fixtures/ranking.js";
import { initial, order, previewFonts, containedActions } from "./rank-footer-checks.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { root?.unmount(); host?.remove(); root = undefined; host = undefined; });

/** D20/D34: measure the hit area at its edges, including a toast's expanded Undo. */
function touchReach() {
  const buttons = [...document.querySelectorAll<HTMLElement>('[data-rank-actions] button, [data-rank-actions] [role="button"]')];
  expect(buttons.length).toBeGreaterThan(0);
  const targets = [];
  const card = document.querySelector<HTMLElement>(".bk-askrank")!.getBoundingClientRect();
  for (const button of buttons) {
    const bounds = button.getBoundingClientRect();
    // These fixture labels are single-line; compare their paint to the original
    // small Button and text-sized Undo, separately from the hit-area assertions.
    expect(bounds.height, `compact footer paint: ${button.textContent?.trim()}`)
      .toBeCloseTo(button.classList.contains("bk-undo") ? 13.65 : 28.375, 1);
    const style = getComputedStyle(button);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      expect(style.getPropertyValue(`border-${side.toLowerCase()}-width`),
        `border-free expanded target: ${button.textContent?.trim()}`).toBe("0px");
    }
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    for (const dx of [-21.5, 21.5]) for (const dy of [-21.5, 21.5]) {
      expect(document.elementFromPoint(x + dx, y + dy)?.closest('button, [role="button"]'),
        `44px footer touch reach: ${button.textContent?.trim()}`).toBe(button);
    }
    const reach = getComputedStyle(button, "::before");
    expect(reach.backgroundColor, "touch expansion is transparent").toBe("rgba(0, 0, 0, 0)");
    const target = { button,
      left: bounds.left + parseFloat(reach.left), right: bounds.right - parseFloat(reach.right),
      top: bounds.top + parseFloat(reach.top), bottom: bounds.bottom - parseFloat(reach.bottom),
    };
    expect(target.right - target.left).toBeGreaterThanOrEqual(44);
    expect(target.bottom - target.top).toBeGreaterThanOrEqual(44);
    expect(target.left).toBeGreaterThanOrEqual(card.left);
    expect(target.right).toBeLessThanOrEqual(card.right);
    expect(target.top).toBeGreaterThanOrEqual(card.top);
    expect(target.bottom).toBeLessThanOrEqual(card.bottom);
    targets.push(target);
    // Sample the expanded area's full edges as well as its central 44px square.
    for (const x of [target.left + 0.5, target.right - 0.5]) {
      for (const y of [target.top + 0.5, target.bottom - 0.5]) {
        expect(document.elementFromPoint(x, y)?.closest('button, [role="button"]'),
          `expanded footer edge: ${button.textContent?.trim()}`).toBe(button);
      }
    }
  }
  for (let i = 0; i < targets.length; i++) for (const other of targets.slice(i + 1)) {
    const target = targets[i];
    const overlaps = Math.min(target.right, other.right) > Math.max(target.left, other.left)
      && Math.min(target.bottom, other.bottom) > Math.max(target.top, other.top);
    expect(overlaps, `footer targets overlap: ${target.button.textContent?.trim()} / ${other.button.textContent?.trim()}`).toBe(false);
  }
}

async function tapAction(name: string, edge = false) {
  const button = page.getByRole("button", { name, exact: true }).element() as HTMLElement;
  const bounds = button.getBoundingClientRect();
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 + (edge ? 21.5 : 0) };
  await commands.rankTouch("touchStart", [point]);
  await commands.rankTouch("touchEnd", []);
}

for (const theme of ["dark", "light"] as const) for (const width of [240, 320, 960]) {
  test(`rank footer retains 44px touch reach through pending states: ${theme}, ${width}`, async () => {
    await page.viewport(width === 960 ? 1024 : 360, 1200);
    expect(matchMedia("(any-pointer: coarse)").matches).toBe(true);
    await previewFonts();
    const submit = vi.fn(); const dismiss = vi.fn();
    document.documentElement.dataset.theme = theme;
    host = document.createElement("div"); host.style.width = `${width}px`; document.body.append(host);
    root = createRoot(host);
    // The same five-choice input as RankUntouched, in a separate touch renderer.
    flushSync(() => root!.render(createElement(AskUserRankCard, {
      question: "Which crossing first?", items: rankingJourneys.slice(0, 5), onSubmit: submit, onDismiss: dismiss,
    })));
    expect(initial).toHaveLength(5);
    expect(order()).toEqual(initial);
    containedActions(["Dismiss", "Keep this order"]); touchReach();
    await tapAction("Keep this order", true);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ order: initial, unchanged: true }); submit.mockClear();
    await commands.rankFooterDrag();
    expect(order()).toEqual([initial[2], initial[0], initial[1], initial[3], initial[4]]);
    containedActions(["Dismiss", "Reset", "Submit order"]); touchReach();
    await commands.rankFooterCapture(`touch-changed-${theme}-${width}`);
    await tapAction("Reset", true);
    expect(order()).toEqual(initial);
    containedActions(["Undo", "Dismiss", "Keep this order"]); touchReach();
    await commands.rankFooterCapture(`touch-reset-${theme}-${width}`);
    await tapAction("Undo", true);
    expect(order()[0]).toBe(initial[2]);
    await userEvent.click(page.getByRole("button", { name: "Circe’s island, position 1 of 5", exact: true }));
    containedActions(["Cancel"]); touchReach();
    await commands.rankFooterCapture(`touch-picked-${theme}-${width}`);
    await tapAction("Cancel", true);
    expect(order()[0]).toBe(initial[2]);
    containedActions(["Dismiss", "Reset", "Submit order"]); touchReach();
    await tapAction("Submit order", true);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ order: [initial[2], initial[0], initial[1], initial[3], initial[4]], unchanged: false });
    await tapAction("Dismiss", true); expect(dismiss).toHaveBeenCalledTimes(1);
  });
}
