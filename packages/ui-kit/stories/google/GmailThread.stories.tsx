import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import { loomMessages, midQuoteMessage, spartaMessages, structuredMessages } from "../../fixtures/gmail.js";
import { GmailThread } from "../../src/google/GmailThread.js";
import { STRUCTURED_LINE } from "../../src/google/shared.js";
import { stage } from "../_stage.js";
import { containment, desktop, holdsTogether, narrow, widthOf } from "./_gmail.js";

/**
 * One Gmail thread (#4209; brief §3, rulings G3 and G5): oldest first, the
 * newest message open, earlier ones as one-line rows that open in place,
 * and with four or more earlier messages all but the last two folded into
 * one row. A body's trailing quoted history folds behind "Show quoted text".
 */
const meta = preview.meta({
  title: "Gmail/GmailThread",
  component: GmailThread,
  decorators: [stage],
  args: { view: "content", messages: spartaMessages },
});

const toggles = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("[data-gmail-thread-message] > button")];

/** Two messages: the earlier one a row, the newest open. */
export const TwoMessages = meta.story({
  args: { view: "content", messages: spartaMessages },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(toggles(canvasElement).map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    await expect(canvas.getByRole("heading", { name: "Leaving for Sparta" })).toBeVisible();
    await expect(canvas.getByRole("list", { name: "Messages, oldest first" })).toBeVisible();
    const strings = ["Leaving for Sparta", "Telemachus", "The island part is true"];
    const where = containment(canvasElement, strings);
    await expect(where.unguarded, "nothing a stranger wrote sits outside an untrusted field").toEqual([]);
    await expect(where.guarded, "each one is on screen, inside one").toEqual(strings);
  },
});
export const TwoMessagesNarrow = TwoMessages.extend({ ...narrow });

/** An earlier message opened from the keyboard: it opens in place and focus stays on its row. */
export const EarlierMessageOpens = meta.story({
  args: { view: "content", messages: spartaMessages },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    const row = canvas.getByRole("button", { name: "Telemachus, Wednesday 8 July 2026, 07:15" });
    row.focus();
    await userEvent.keyboard("{Enter}");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(document.activeElement, "focus stays on the row it opened").toBe(row);
    const panel = document.getElementById(row.getAttribute("aria-controls")!)!;
    await expect(panel.textContent).toContain("Menelaus has news of you");
    await expect(panel.textContent).toContain("telemachus@example.com");
    await expect(panel.querySelector("[data-gmail-recipients]")!.textContent).toBe("to Odysseus · cc Penelope");
    await holdsTogether(canvasElement, widthOf(parameters));
  },
});
export const EarlierMessageOpensNarrow = EarlierMessageOpens.extend({ ...narrow });

/**
 * Five messages at rest: the first two folded into one row, the next two as
 * rows, the newest open. Nothing is pressed, so its capture is the folded
 * thread (`gmail-thread-folded`).
 */
export const FiveMessagesFoldedAtRest = meta.story({
  args: { view: "content", messages: loomMessages },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByRole("button", { name: "Show 2 earlier messages" })).toBeVisible();
    await expect(toggles(canvasElement).map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false", "true"]);
  },
});
export const FiveMessagesFoldedAtRestNarrow = FiveMessagesFoldedAtRest.extend({ ...narrow });

/** Five messages: the first two fold into one row; opening it moves focus to the first message it revealed. */
export const FiveMessagesFolded = meta.story({
  args: { view: "content", messages: loomMessages },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(toggles(canvasElement)).toHaveLength(3);
    const fold = canvas.getByRole("button", { name: "Show 2 earlier messages" });
    fold.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(toggles(canvasElement)[0]));
    await expect(document.activeElement).toHaveAccessibleName("Penelope, Tuesday 7 July 2026, 20:11");
    await expect(canvas.queryByRole("button", { name: /earlier message/ })).toBeNull();
    await expect(toggles(canvasElement).map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false", "true"]);
    await holdsTogether(canvasElement, widthOf(parameters));
  },
});
export const FiveMessagesFoldedNarrow = FiveMessagesFolded.extend({ ...narrow });

/** The newest body ends in quoted history: it folds behind "Show quoted text", and the payload is unchanged. */
export const QuotedHistoryCollapsed = meta.story({
  args: { view: "content", messages: loomMessages.slice(2) },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const open = canvasElement.querySelector<HTMLElement>("[data-gmail-thread-message='open']")!;
    const toggle = canvas.getAllByRole("button", { name: "Show quoted text" }).find((b) => open.contains(b))!;
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(open.querySelector("[data-gmail-body]")!.textContent).not.toContain("Tell them it's for Laertes");
    await expect(open.querySelector("[data-gmail-body]")!.textContent).toContain("Come home before the last of the wool.");
  },
});
export const QuotedHistoryCollapsedNarrow = QuotedHistoryCollapsed.extend({ ...narrow });

/** "Show quoted text" pressed: the attribution and the quote appear in place, and focus stays on the control. */
export const QuotedHistoryOpen = meta.story({
  args: { view: "content", messages: loomMessages.slice(2) },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    const open = canvasElement.querySelector<HTMLElement>("[data-gmail-thread-message='open']")!;
    const toggle = canvas.getAllByRole("button", { name: "Show quoted text" }).find((b) => open.contains(b))!;
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAccessibleName("Hide quoted text");
    await expect(document.activeElement, "focus stays on the control").toBe(toggle);
    const quoted = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    await expect(quoted.textContent).toContain("On Fri, 10 Jul 2026 at 07:05, Odysseus <odysseus@example.com> wrote:");
    await expect(quoted.querySelectorAll("blockquote").length).toBeGreaterThan(0);
    await holdsTogether(canvasElement, widthOf(parameters));
  },
});
export const QuotedHistoryOpenNarrow = QuotedHistoryOpen.extend({ ...narrow });

/** A quote with the sender's own words after it is part of what they wrote: it stays, and nothing folds. */
export const QuotedMidBody = meta.story({
  args: { view: "content", messages: [loomMessages[1]!, midQuoteMessage] },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const open = canvasElement.querySelector<HTMLElement>("[data-gmail-thread-message='open']")!;
    await expect(open.querySelector("[data-gmail-quoted-toggle]")).toBeNull();
    await expect(open.querySelector("blockquote")!.textContent).toBe("Keep unweaving.");
    await expect(canvas.getByText(/I am\. Every night/)).toBeVisible();
  },
});
export const QuotedMidBodyNarrow = QuotedMidBody.extend({ ...narrow });

/** An attachment: its name, size and "not loaded"; nothing fetches it. */
export const Attachments = meta.story({
  args: { view: "content", messages: loomMessages.slice(3) },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const list = canvas.getByRole("list", { name: "Attachment" });
    await expect(list.textContent).toBe("shroud-pattern.pdf · 120 KB · not loaded");
    await expect(canvasElement.querySelectorAll("a, img, iframe, object, embed")).toHaveLength(0);
  },
});
export const AttachmentsNarrow = Attachments.extend({ ...narrow });

/** The structured view: dates, labels and counts under the one G1 line; no sender, subject or body. */
export const Structured = meta.story({
  args: { view: "structured", messages: structuredMessages },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters), { controls: 0 });
    await expect(canvas.getByRole("heading", { name: "Thread · 5 messages" })).toBeVisible();
    await expect(canvas.getByText(STRUCTURED_LINE)).toBeVisible();
    const text = canvasElement.textContent ?? "";
    for (const word of ["Penelope", "Odysseus", "loom", "@", "Laertes"]) await expect(text).not.toContain(word);
    await expect(canvasElement.querySelectorAll("[data-gmail-row='structured']")).toHaveLength(5);
  },
});
export const StructuredNarrow = Structured.extend({ ...narrow });
