/// <reference types="@vitest/browser/matchers" />
import { expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { RankUntouched, RankWide } from "../../stories/decisions/AskUserRankCard.stories.js";
import { initial, order, previewFonts, containedActions } from "./rank-footer-checks.js";

/** Assert the reading itself: each keyboard instruction stays on one line. */
function readableHint(singleKeys = true) {
  const hint = document.querySelector<HTMLElement>(".bk-rank-keys")!;
  expect(hint.textContent).toBe(`space pick up · ↑↓ move${singleKeys ? " · 1–9 place" : ""}`);
  expect(hint.getBoundingClientRect().width).toBeGreaterThan(0);
  // React emits the optional digit shortcut as a separate text node.
  const nodes = [...hint.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE);
  function position(offset: number): [Node, number] {
    for (const node of nodes) {
      const length = node.textContent!.length;
      if (offset <= length) return [node, offset];
      offset -= length;
    }
    throw new Error("Keyboard phrase is outside its text nodes");
  }
  for (const phrase of ["space pick up", "↑↓ move", ...(singleKeys ? ["1–9 place"] : [])]) {
    const start = hint.textContent!.indexOf(phrase);
    expect(start).toBeGreaterThanOrEqual(0);
    const range = document.createRange();
    range.setStart(...position(start)); range.setEnd(...position(start + phrase.length));
    const lines = [...range.getClientRects()];
    expect(lines, `keyboard hint phrase wraps: ${phrase}`).toHaveLength(1);
  }
  return hint.getBoundingClientRect();
}
for (const theme of ["dark", "light"] as const) {
  for (const width of [320, 960]) {
    for (const singleKeys of [true, false]) {
      test(`rank footer keeps keyboard phrases readable after reorder: ${theme}, ${width}${singleKeys ? "" : ", arrows only"}`, async () => {
        await page.viewport(width === 320 ? 360 : 1024, 1200);
        expect(matchMedia("(any-pointer: fine)").matches).toBe(true);
        await previewFonts();
        const variant = singleKeys ? "" : "-arrows-only";
        const submit = vi.fn();
        const dismiss = vi.fn();
        const story = (width === 320 ? RankUntouched : RankWide).extend({ args: { onSubmit: submit, onDismiss: dismiss, singleKeys } });
        await story.run({ globals: { theme } });
        expect(document.documentElement.dataset.theme).toBe(theme);
        expect(initial).toHaveLength(5);
        expect(order()).toEqual(initial); // Actual five-choice story.
        readableHint(singleKeys); containedActions(["Dismiss", "Keep this order"]);
        await userEvent.click(page.getByRole("button", { name: "Keep this order", exact: true }));
        expect(submit).toHaveBeenCalledExactlyOnceWith({ order: initial, unchanged: true });
        submit.mockClear();
        await commands.rankFooterCapture(`unchanged-${theme}-${width}${variant}`);

        await commands.rankFooterDrag();
        expect(order()).toEqual([initial[2], initial[0], initial[1], initial[3], initial[4]]);
        await commands.rankFooterCapture(`changed-${theme}-${width}${variant}`);
        const hint = readableHint(singleKeys); // This assertion must fail for the old layout.
        containedActions(["Dismiss", "Reset", "Submit order"]);
        console.info(`rank footer ${theme} ${width}: hint ${hint.width} × ${hint.height}`);
        if (singleKeys) await expect(document.querySelector<HTMLElement>(".bk-askrank")!).toMatchScreenshot(`rank-footer-changed-${theme}-${width}`, { comparatorOptions: { threshold: 0.03 } });

        await userEvent.click(page.getByRole("button", { name: "Reset", exact: true }));
        expect(order()).toEqual(initial);
        readableHint(singleKeys); containedActions(["Undo", "Dismiss", "Keep this order"]);
        await commands.rankFooterCapture(`reset-${theme}-${width}${variant}`);
        await userEvent.click(page.getByRole("button", { name: "Undo", exact: true }));
        expect(order()[0]).toBe(initial[2]);
        readableHint(singleKeys); containedActions(["Dismiss", "Reset", "Submit order"]);

        const first = page.getByRole("button", { name: "Circe’s island, position 1 of 5", exact: true });
        await userEvent.click(first);
        containedActions(["Cancel"]);
        await commands.rankFooterCapture(`picked-${theme}-${width}${variant}`);
        await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
        expect(order()[0]).toBe(initial[2]); readableHint(singleKeys);
        // Exercise the keyboard reorder path on this same composition.
        await userEvent.click(first);
        await userEvent.keyboard("{ArrowDown}{Enter}");
        expect(order()[1]).toBe(initial[2]);
        readableHint(singleKeys); containedActions(["Dismiss", "Reset", "Submit order"]);
        await userEvent.click(page.getByRole("button", { name: "Submit order", exact: true }));
        expect(submit).toHaveBeenCalledExactlyOnceWith({ order: [initial[0], initial[2], initial[1], initial[3], initial[4]], unchanged: false });
        await userEvent.click(page.getByRole("button", { name: "Dismiss", exact: true }));
        expect(dismiss).toHaveBeenCalledTimes(1);
      });
    }
  }
}
