import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import { contentThreads, hiddenCharsThread, longSenderThread, sparseStructuredThread, structuredThreads } from "../../fixtures/gmail.js";
import { GmailResultList, type GmailContentThread } from "../../src/google/GmailResultList.js";
import { STRUCTURED_LINE } from "../../src/google/shared.js";
import { stage } from "../_stage.js";
import { desktop, holdsTogether, narrow, unguarded, widthOf } from "./_gmail.js";

/**
 * The threads a Gmail search returned (#4209; brief §1, §2, §6; rulings G1
 * and G5). The structured view says once, in its header, that Brain read
 * no message, and its rows carry nothing a stranger wrote; the content view
 * shows sender, subject and snippet as untrusted fields, and a row opens in
 * place.
 */
const meta = preview.meta({
  title: "Gmail/GmailResultList",
  component: GmailResultList,
  decorators: [stage],
  args: { view: "structured", query: "category:promotions older_than:30d", threads: structuredThreads.slice(0, 5) },
});

/** Words no structured story may show: a sender, a subject, an address, a placeholder for either. */
const NEVER_STRUCTURED = ["@", "Penelope", "Eumaeus", "Telemachus", "Calypso", "subject", "sender", "From", "loom"];

const structuredHolds = async (canvasElement: HTMLElement, parameters: Record<string, unknown>) => {
  await holdsTogether(canvasElement, widthOf(parameters));
  const text = canvasElement.textContent ?? "";
  for (const word of NEVER_STRUCTURED) await expect(text, `a structured row shows no "${word}"`).not.toContain(word);
  await expect(text.split(STRUCTURED_LINE), "the G1 line appears exactly once").toHaveLength(2);
  await expect(canvasElement.querySelectorAll("[data-gmail-row='structured'] [aria-expanded]"), "a structured row does not expand").toHaveLength(0);
};

// ---------------------------------------------------------------- structured

/** One thread: the header and that row. */
export const Structured1 = meta.story({
  args: { view: "structured", threads: structuredThreads.slice(0, 1) },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await structuredHolds(canvasElement, parameters);
    await expect(canvas.getByRole("heading", { name: "1 thread" })).toBeVisible();
    await expect(canvas.getAllByRole("listitem").filter((li) => li.matches("[data-gmail-row]"))).toHaveLength(1);
  },
});
export const Structured1Narrow = Structured1.extend({ ...narrow });

/**
 * Five threads, all shown. The date and count lead; on desktop the labels
 * and flags move into a second column beside them.
 */
export const Structured5 = meta.story({
  args: { view: "structured", threads: structuredThreads.slice(0, 5) },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await structuredHolds(canvasElement, parameters);
    const row = canvasElement.querySelector<HTMLElement>("[data-gmail-row='structured']")!;
    const when = row.querySelector(".bk-gm-when")!.getBoundingClientRect();
    const labels = row.querySelector("[data-gmail-labels]")!.getBoundingClientRect();
    if (widthOf(parameters) === "desktop") {
      await expect(labels.left, "desktop: the labels sit beside the date").toBeGreaterThan(when.right - 1);
      await expect(Math.abs(labels.top - when.top), "desktop: on the date's line").toBeLessThan(6);
    } else {
      await expect(labels.top, "phone: the labels sit under the date").toBeGreaterThanOrEqual(when.bottom - 1);
      await expect(Math.abs(labels.left - when.left), "phone: in the date's column").toBeLessThan(1);
    }
  },
});
export const Structured5Narrow = Structured5.extend({ ...narrow });

/** Twenty-five, the page maximum: eight rows, then Show more, which moves focus to the first new row. */
export const Structured25 = meta.story({
  args: { view: "structured", threads: structuredThreads },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    await structuredHolds(canvasElement, parameters);
    await expect(canvasElement.querySelectorAll("[data-gmail-row]")).toHaveLength(8);
    const more = canvas.getByRole("button", { name: "Show 17 more · 8 of 25 shown" });
    more.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(canvasElement.querySelectorAll("[data-gmail-row]")[8]));
    await expect(document.activeElement?.textContent).toContain("Tue 7 Jul 20:11");
    await expect(canvasElement.querySelectorAll("[data-gmail-row]")).toHaveLength(25);
    await holdsTogether(canvasElement, widthOf(parameters));
  },
});
export const Structured25Narrow = Structured25.extend({ ...narrow });

/** A next page exists: the footnote says Gmail has more and how to ask, never a total. */
export const StructuredNextPage = meta.story({
  args: { view: "structured", threads: structuredThreads.slice(0, 10), nextPage: true },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await structuredHolds(canvasElement, parameters);
    await expect(canvas.getByText("Gmail has more matches. Ask Brain for the next page.")).toBeVisible();
  },
});
export const StructuredNextPageNarrow = StructuredNextPage.extend({ ...narrow });

/** Nulls are not falses: a row whose payload withheld the date, count, size and flags shows only its label. */
export const StructuredSparse = meta.story({
  args: { view: "structured", threads: [sparseStructuredThread, ...structuredThreads.slice(0, 2)] },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await structuredHolds(canvasElement, parameters);
    await expect(canvasElement.querySelector("[data-gmail-row]")!.textContent).toBe("Inbox");
  },
});
export const StructuredSparseNarrow = StructuredSparse.extend({ ...narrow });

/** Nothing found: the header keeps the query. */
export const StructuredEmpty = meta.story({
  args: { view: "structured", threads: [], query: "label:raft older_than:1y" },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await structuredHolds(canvasElement, parameters);
    await expect(canvas.getByText("— Gmail found nothing for this search.")).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "0 threads" })).toBeVisible();
  },
});
export const StructuredEmptyNarrow = StructuredEmpty.extend({ ...narrow });

// ------------------------------------------------------------------ content

const UNTRUSTED = (threads: readonly GmailContentThread[]) =>
  threads.flatMap((t) => [t.untrusted.subject, t.untrusted.snippet]).filter((s): s is string => !!s);

/** Four threads: sender and date, subject, snippet, then count, labels and flags. */
export const Content4 = meta.story({
  args: { view: "content", query: "in:inbox newer_than:7d", threads: contentThreads },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(unguarded(canvasElement, UNTRUSTED(contentThreads)), "every subject and snippet is an untrusted field").toEqual([]);
    await expect(canvas.getByText("Content view · written by others · not checked")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Unread, Penelope, The loom, again, Saturday 11 July 2026, 18:02, 5 messages, has an attachment" })).toHaveAttribute("aria-expanded", "false");
    await expect(canvasElement.querySelectorAll("a"), "no row links anywhere").toHaveLength(0);
  },
});
export const Content4Narrow = Content4.extend({ ...narrow });

/** A row opened from the keyboard: the headers as written, the whole snippet and every label; focus stays on the row. */
export const ContentRowOpen = meta.story({
  args: { view: "content", query: "in:inbox newer_than:7d", threads: contentThreads },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    const row = canvas.getByRole("button", { name: /^Unread, Penelope, The loom, again/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(document.activeElement, "focus stays on the row it opened").toBe(row);
    const panel = document.getElementById(row.getAttribute("aria-controls")!)!;
    await expect(panel.textContent).toContain("Penelope <penelope@example.com>");
    await expect(panel.textContent).toContain("Eurycleia <eurycleia@example.com>");
    await expect([...panel.querySelectorAll("[data-gmail-label]")].map((n) => n.textContent)).toEqual(["Inbox", "Family", "Ithaca", "Voyage"]);
    await userEvent.keyboard(" ");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(document.activeElement).toBe(row);
    await userEvent.keyboard("{Enter}");
    await holdsTogether(canvasElement, widthOf(parameters));
  },
});
export const ContentRowOpenNarrow = ContentRowOpen.extend({ ...narrow });

/** No subject: a muted "— no subject", which is not data and cannot be mistaken for any. */
export const ContentNoSubject = meta.story({
  args: { view: "content", query: "in:inbox newer_than:7d", threads: [contentThreads[3]!] },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const placeholder = canvas.getByText("— no subject");
    await expect(placeholder.closest("[data-untrusted-field]"), "the placeholder is the kit's, not the sender's").toBeNull();
    await expect(getComputedStyle(placeholder).fontStyle).toBe("italic");
  },
});
export const ContentNoSubjectNarrow = ContentNoSubject.extend({ ...narrow });

/** A long sender and a long subject: the sender gives way to the date, the subject wraps to two lines, then clamps. */
export const ContentLongSender = meta.story({
  args: { view: "content", query: "in:inbox newer_than:7d", threads: [longSenderThread, contentThreads[2]!] },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const row = canvasElement.querySelector<HTMLElement>("[data-gmail-row='content']")!;
    const date = row.querySelector("time")!.getBoundingClientRect();
    const name = row.querySelector(".bk-gm-grow")!.getBoundingClientRect();
    await expect(date.right, "the date keeps its place at the row's end").toBeLessThanOrEqual(row.getBoundingClientRect().right);
    await expect(name.right, "the sender stops before the date").toBeLessThanOrEqual(date.left);
    const subject = row.querySelector<HTMLElement>(".bk-gm-subject")!;
    const line = parseFloat(getComputedStyle(subject).lineHeight);
    const lines = Math.round(subject.getBoundingClientRect().height / line);
    await expect(lines, "two subject lines on a phone, one on desktop").toBe(widthOf(parameters) === "narrow" ? 2 : 1);
  },
});
export const ContentLongSenderNarrow = ContentLongSender.extend({ ...narrow });

/** A content search that found nothing. */
export const ContentEmpty = meta.story({
  args: { view: "content", threads: [], query: "from:poseidon" },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(canvas.getByText("— Gmail found nothing for this search.")).toBeVisible();
  },
});
export const ContentEmptyNarrow = ContentEmpty.extend({ ...narrow });

/**
 * Hidden characters (G4): an override that would turn `txt.exe` around, a
 * zero-width space inside the sender's name, a run of four in the snippet
 * and tag characters spelling a hidden word, each a named marker.
 */
export const HiddenCharsInSubject = meta.story({
  args: { view: "content", query: "is:unread", threads: [hiddenCharsThread] },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    const markers = [...canvasElement.querySelectorAll("[data-hidden-char]")].map((n) => n.getAttribute("data-hidden-char"));
    await expect(markers.slice(0, 3)).toEqual(["‹U+200B›", "‹U+202E›", "‹U+200B ×4›"]);
    await expect(canvasElement.textContent ?? "").not.toMatch(/[\u{200B}\u{202E}\u{E0049}]/u);
    await expect(canvas.getByRole("button", { name: /Ithaca‹U\+200B› Steward, Invoice for the shroud wool ‹U\+202E›txt\.exe/ })).toBeVisible();
    // The subject reads left to right as written: the marker sits before "txt.exe", which is not reversed.
    const subject = canvasElement.querySelector<HTMLElement>(".bk-gm-subject [data-untrusted-field]")!;
    const marker = subject.querySelector("[data-hidden-char]")!.getBoundingClientRect();
    const tail = [...subject.querySelectorAll("bdi")].find((b) => b.textContent === "txt.exe")!.getBoundingClientRect();
    await expect(tail.left, "txt.exe follows its marker, left to right").toBeGreaterThanOrEqual(marker.right - 1);
  },
});
export const HiddenCharsInSubjectNarrow = HiddenCharsInSubject.extend({ ...narrow });
