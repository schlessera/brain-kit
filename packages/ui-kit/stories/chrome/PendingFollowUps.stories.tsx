import preview from "#.storybook/preview";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { longFollowUp, pendingFollowUps } from "../../fixtures/follow-ups.js";
import { ComposerRow } from "../../src/chrome/ComposerRow.js";
import { PendingFollowUps } from "../../src/chrome/PendingFollowUps.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/PendingFollowUps",
  component: PendingFollowUps,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: { followUps: pendingFollowUps.slice(0, 1) },
  // The right half of the row above the composer: its pills read that half's
  // width, and its popover never grows wider than it, so every story draws it
  // where it lives.
  render: (args) => <ComposerRow right={<PendingFollowUps {...args} />} />,
});

const group = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-pending-follow-ups]")!;
const items = (root: HTMLElement) => [...group(root).children] as HTMLElement[];

/** One follow-up: one 44px pill, its label, `pending`, and its full text as
 * the description. */
export const One = meta.story({
  play: async ({ canvas, canvasElement }) => {
    const pill = canvas.getByRole("button", { name: "Pending follow-up 1 of 1: Winds from Aeolus. Not yet received by the agent." });
    await expect(pill.getBoundingClientRect().height).toBe(44);
    await expect(pill).toHaveAccessibleDescription(pendingFollowUps[0]!.text);
    await expect(pill).toHaveTextContent("pending");
    await expect(canvas.getByRole("group", { name: "Pending follow-ups" })).toBeInTheDocument();
    // In the right half, on the composer edge.
    const half = canvasElement.querySelector<HTMLElement>('[data-row-half="right"]')!.getBoundingClientRect();
    await expect(pill.getBoundingClientRect().right).toBe(half.right);
  },
});

/** Two: both pills, oldest on top, 6px apart: 94px. A pill without a label
 * prints the start of its prompt. */
export const Two = meta.story({
  args: { followUps: pendingFollowUps.slice(0, 2) },
  play: async ({ canvas, canvasElement }) => {
    const [first, second] = items(canvasElement).map((el) => el.getBoundingClientRect());
    await expect(second!.top - first!.bottom).toBe(6);
    await expect(group(canvasElement).getBoundingClientRect().height).toBe(94);
    await expect(canvas.getAllByRole("button")[1]).toHaveAccessibleName(
      "Pending follow-up 2 of 2: Count the timber again once…. Not yet received by the agent.",
    );
  },
});

/** Three: the oldest pill and `+2 pending`, which opens the sheet listing every
 * message in full, in send order, numbered. Still 94px. */
export const Three = meta.story({
  args: { followUps: pendingFollowUps.slice(0, 3) },
  play: async ({ canvas, canvasElement }) => {
    await expect(group(canvasElement).getBoundingClientRect().height).toBe(94);
    await expect(canvas.getAllByRole("button")[0]).toHaveAccessibleName(/^Pending follow-up 1 of 3: Winds from Aeolus/);
    const summary = canvas.getByRole("button", { name: "2 pending follow-ups. Open list." });
    await expect(summary).toHaveTextContent("+2 pending");
    await userEvent.click(summary);
    const sheet = await screen.findByRole("dialog", { name: "Pending follow-ups" });
    const rows = [...sheet.querySelectorAll<HTMLElement>("[data-pending-row]")];
    await expect(rows.map((row) => row.querySelector(".bk-pending-count")!.textContent)).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    await expect(rows[2]).toHaveTextContent(pendingFollowUps[2]!.text);
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    // Read-only: nothing in the sheet sends, cancels or navigates.
    await expect(sheet.querySelectorAll("button, a, [role=button]")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expect(document.activeElement).toBe(summary);
  },
});

/** Many: the summary counts every message but the oldest. */
export const Many = meta.story({
  args: { followUps: [...pendingFollowUps, longFollowUp] },
  play: async ({ canvas, canvasElement }) => {
    await expect(group(canvasElement).getBoundingClientRect().height).toBe(94);
    await expect(canvas.getByRole("button", { name: "5 pending follow-ups. Open list." })).toHaveTextContent("+5 pending");
  },
});

/** A long prompt: the pill truncates its label, and hovering it reveals the
 * whole text, wrapped inside the half, at most 280px. */
export const LongPrompt = meta.story({
  args: { followUps: [longFollowUp] },
  play: async ({ canvas, canvasElement }) => {
    const pill = canvas.getByRole("button", { name: /^Pending follow-up 1 of 1: Before we leave Ogygia, compare…/ });
    await expect(pill.getBoundingClientRect().height).toBe(44);
    await userEvent.hover(pill);
    const text = canvasElement.querySelector<HTMLElement>("[data-follow-up-text]")!;
    await waitFor(() => expect(text.hidden).toBe(false));
    const half = canvasElement.querySelector<HTMLElement>('[data-row-half="right"]')!.getBoundingClientRect();
    const box = text.getBoundingClientRect();
    await expect(box.width).toBeLessThanOrEqual(Math.min(280, half.width));
    await expect(box.left).toBeGreaterThanOrEqual(half.left);
    await expect(box.bottom).toBeLessThanOrEqual(pill.getBoundingClientRect().top);
    await expect(text).toHaveTextContent(longFollowUp.text);
    // The pointer can travel onto the popover to select the text.
    await userEvent.hover(text);
    await expect(text.hidden).toBe(false);
    await userEvent.unhover(text);
    await waitFor(() => expect(text.hidden).toBe(true));
  },
});

/** Keyboard focus reveals the full text; Esc and Enter close it; arrows rove
 * between the two items and the group is one tab stop. */
export const Keyboard = meta.story({
  args: { followUps: pendingFollowUps.slice(0, 2) },
  play: async ({ canvas, canvasElement }) => {
    const [first, second] = canvas.getAllByRole("button");
    const texts = [...canvasElement.querySelectorAll<HTMLElement>("[data-follow-up-text]")];
    await expect(texts.every((t) => t.hidden)).toBe(true);
    await userEvent.tab();
    await expect(document.activeElement).toBe(first);
    await waitFor(() => expect(texts[0]!.hidden).toBe(false));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(texts[0]!.hidden).toBe(true));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(texts[0]!.hidden).toBe(false));
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(second);
    await waitFor(() => expect(texts[1]!.hidden).toBe(false));
    await expect(texts[0]!.hidden).toBe(true);
    await expect(group(canvasElement).querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  },
});

/** Keyboard up: the half collapses to one 44px summary that opens the sheet. */
export const KeyboardUp = meta.story({
  args: { followUps: pendingFollowUps.slice(0, 2), keyboardOpen: true },
  play: async ({ canvas, canvasElement }) => {
    const summary = canvas.getByRole("button", { name: "2 pending follow-ups. Open list." });
    await expect(summary).toHaveTextContent("2 pending");
    await expect(group(canvasElement).getBoundingClientRect().height).toBe(44);
  },
});

/** A single follow-up with the keyboard up still reads `1 pending`. */
export const KeyboardUpOne = KeyboardUp.extend({
  args: { followUps: pendingFollowUps.slice(0, 1), keyboardOpen: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "1 pending follow-up. Open list." })).toHaveTextContent("1 pending");
  },
});

/** None: no pill, so the row is absent; the live region still exists. */
export const None = meta.story({
  args: { followUps: [], announcement: "Follow-up sent to the agent", announcementKey: 1 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector<HTMLElement>("[data-composer-row]")!.getBoundingClientRect().height).toBe(0);
    await expect(document.querySelector("[data-pending-live]")).toHaveTextContent("Follow-up sent to the agent");
  },
});
