import preview from "#.storybook/preview";
import { expect, fn, userEvent } from "storybook/test";
import { AskUserRankCard } from "../../src/decisions/AskUserRankCard.js";
import { rankingJourneys } from "../../fixtures/ranking.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({ title: "Decisions/Ranked question", component: AskUserRankCard, decorators: [stage], parameters: { stageWidth: 320 } });
const five = rankingJourneys.slice(0, 5);
const ids = five.map((item) => item.id);
const args = { question: "Which crossing first?", items: five, onSubmit: fn(), onDismiss: fn() };

async function geometry(root: HTMLElement) {
  await expect(overflowing(root)).toEqual([]);
  const card = root.querySelector<HTMLElement>(".bk-askrank")!;
  await expect(card.getBoundingClientRect().width).toBeGreaterThan(200);
  await Promise.all(card.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
  const scroll = window.scrollY;
  for (const handle of root.querySelectorAll<HTMLElement>("[data-rank-handle]")) {
    handle.scrollIntoView({ block: "center" });
    const paint = handle.getBoundingClientRect();
    const reach = getComputedStyle(handle, "::before");
    const row = handle.closest<HTMLElement>("[data-rank-row]")!.getBoundingClientRect();
    await expect(paint.height - parseFloat(reach.top) - parseFloat(reach.bottom)).toBeGreaterThanOrEqual(row.height - 1);
    for (const y of [row.top + 1, row.bottom - 1]) await expect(document.elementFromPoint(paint.left + 8, y)?.closest("[data-rank-handle]")).toBe(handle);
    await expect(getComputedStyle(handle).borderWidth).toBe("0px");
    await expect(getComputedStyle(handle).touchAction).toBe("none");
    await expect(paint.width - parseFloat(reach.left) - parseFloat(reach.right)).toBeGreaterThanOrEqual(44);
    await expect(paint.height - parseFloat(reach.top) - parseFloat(reach.bottom)).toBeGreaterThanOrEqual(44);
    const hit = document.elementFromPoint(paint.left - 13, paint.top + paint.height / 2);
    await expect(hit?.closest("[data-rank-handle]")).toBe(handle);
  }
  window.scrollTo(0, scroll);
}
export const RankUntouched = meta.story({ args, play: async ({ canvasElement }) => geometry(canvasElement) });
export const RankWide = meta.story({ args, parameters: wide, play: async ({ canvasElement }) => geometry(canvasElement) });
export const RankPickedUp = meta.story({ args, play: async ({ canvas, canvasElement }) => {
  await userEvent.click(canvas.getByRole("button", { name: "Circe’s island, position 3 of 5" }));
  await expect(canvas.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(getComputedStyle(canvasElement.querySelector<HTMLElement>("[data-picked]")!).boxShadow).not.toBe("none");
  await geometry(canvasElement);
} });
/** A static lifted frame; pointer travel itself is covered by the browser harness. */
export const RankMidDrag = meta.story({ args, play: async ({ canvas }) => {
  await userEvent.click(canvas.getByRole("button", { name: "Circe’s island, position 3 of 5" }));
} });
export const RankAnswered = meta.story({ args: { ...args, state: "answered", order: [ids[2]!, ids[0]!, ids[4]!, ids[1]!, ids[3]!], unchanged: false } });
export const RankKept = meta.story({ args: { ...args, state: "answered", order: ids, unchanged: true } });
export const RankFifteenCutoff = meta.story({ args: { ...args, items: rankingJourneys, cutoff: 3 }, play: async ({ canvasElement }) => geometry(canvasElement) });
export const RankFifteenAnswered = meta.story({ args: { ...args, items: rankingJourneys, cutoff: 3, state: "answered", order: rankingJourneys.map((item) => item.id), unchanged: true } });
export const RankDismissed = meta.story({ args: { ...args, state: "dismissed", onAskAgain: fn() } });
export const RankKeyboard = meta.story({ args, play: async ({ canvas, args: current, canvasElement }) => {
  const third = canvas.getByRole("button", { name: "Circe’s island, position 3 of 5" });
  third.focus(); await userEvent.keyboard("1");
  await expect(canvasElement.querySelector("[aria-live]")?.textContent).toBe("Circe’s island moved to 1 of 5.");
  const fifth = canvas.getByRole("button", { name: "Aeolus’s floating island, position 5 of 5" });
  fifth.focus(); await userEvent.keyboard("3");
  await expect(canvasElement.querySelector("[aria-live]")?.textContent).toBe("Aeolus’s floating island moved to 3 of 5.");
  await userEvent.click(canvas.getByRole("button", { name: "Submit order" }));
  await expect(current.onSubmit).toHaveBeenCalledWith({ order: [ids[2], ids[0], ids[4], ids[1], ids[3]], unchanged: false });
  await geometry(canvasElement);
} });
