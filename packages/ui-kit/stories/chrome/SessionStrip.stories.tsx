import preview from "#.storybook/preview";
import { expect, fn, screen, userEvent, waitFor } from "storybook/test";

import { WORKING_NOW, longWorkingSession, ogygiaClock, workingByState, workingSessions, type WorkingFixture } from "../../fixtures/sessions.js";
import { ComposerRow } from "../../src/chrome/ComposerRow.js";
import { SessionStrip, type WorkingSession } from "../../src/chrome/SessionStrip.js";
import { stage } from "../_stage.js";

const opens = (list: WorkingFixture[]): WorkingSession[] => list.map((s) => ({ ...s, onOpen: fn() }));

const meta = preview.meta({
  title: "Chrome/SessionStrip",
  component: SessionStrip,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: { sessions: opens([workingByState.running]), now: WORKING_NOW, formatClock: ogygiaClock },
  // The strip is the left half of the row above the composer, and its pills
  // read that half's width, so every story draws it where it lives.
  render: (args) => <ComposerRow left={<SessionStrip {...args} />} />,
});

const pills = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-session-strip] > *')];

/** One working session: one 44px pill, the label then the state word. */
export const One = meta.story({
  play: async ({ canvas, canvasElement }) => {
    const pill = canvas.getByRole("button", { name: "Raft timber tally, running, 2m. Open session." });
    await expect(pill.getBoundingClientRect().height).toBe(44);
    await expect(pills(canvasElement)).toHaveLength(1);
    await expect(canvas.getByRole("group", { name: "Working sessions" })).toBeInTheDocument();
  },
});

/** Two: both pills, 6px apart, so the strip is 94px. */
export const Two = meta.story({
  args: { sessions: opens([workingByState.done, workingByState["needs-you"]]) },
  play: async ({ canvas, canvasElement }) => {
    const [first, second] = pills(canvasElement).map((el) => el.getBoundingClientRect());
    await expect(second!.top - first!.bottom).toBe(6);
    // Urgency, not arrival: needs you sorts above done.
    await expect(canvas.getAllByRole("button")[0]).toHaveAccessibleName("Raft lashing plan, needs you, approval. Open session.");
  },
});

/** Three or more: the most urgent pill and a truthful summary of the rest,
 * which opens the Working sheet listing every session. Still 94px. */
export const Overflow = meta.story({
  args: { sessions: opens([workingByState.running, workingByState.done, workingByState["needs-you"], workingByState.unknown, longWorkingSession]) },
  play: async ({ canvas, canvasElement }) => {
    const strip = canvasElement.querySelector<HTMLElement>("[data-session-strip]")!;
    await expect(strip.getBoundingClientRect().height).toBe(94);
    const summary = canvas.getByRole("button", { name: "4 more working sessions: 2 running, 1 unknown, 1 done. Open list." });
    await userEvent.click(summary);
    const sheet = await screen.findByRole("dialog", { name: "Working" });
    await expect(sheet.querySelectorAll("[data-session]")).toHaveLength(5);
    await waitFor(() => expect(document.activeElement).toBe(sheet.querySelector('[role="button"]')));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expect(document.activeElement).toBe(summary);
  },
});

/** The composer is focused with the soft keyboard up: one 44px summary, never
 * the rejected 32px row. */
export const Collapsed = meta.story({
  args: { sessions: opens([workingByState.running, workingByState["needs-you"], workingByState.done]), keyboardOpen: true },
  play: async ({ canvas }) => {
    const summary = canvas.getByRole("button", { name: "3 working sessions: 1 needs you, 1 running, 1 done. Open list." });
    await expect(summary.getBoundingClientRect().height).toBe(44);
    await expect(summary).toHaveTextContent("3 working");
  },
});

/** Every state's word, tone and second line, in the order the sheet sorts
 * them, which is urgency. The pill row shows the most urgent one. */
export const AllStates = meta.story({
  args: { sessions: opens([...workingSessions].reverse()) },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^8 more working sessions/ }));
    const sheet = await screen.findByRole("dialog", { name: "Working" });
    const order = [...sheet.querySelectorAll<HTMLElement>("[data-state]")].map((el) => el.dataset.state);
    await expect(order).toEqual(workingSessions.map((s) => s.state));
    for (const word of ["needs you", "interrupted", "unconfirmed", "running · 2m", "queued · busy", "unknown", "can't check", "done · 4m", "cancelled"]) {
      await expect(sheet).toHaveTextContent(word);
    }
    // The queue note is printed at rest, not on hover.
    await expect(sheet).toHaveTextContent("3 turns ahead of this one");
    await expect(screen.getByRole("button", { name: "Ship's log summary, queued, busy, 3 turns ahead of this one. Open session." })).toBeVisible();
  },
});

/** 320: the half is under 240px, so pills draw two lines and the summary
 * names only the most urgent count. */
export const Phone320 = Overflow.extend({
  parameters: { stageWidth: 320 },
  play: async ({ canvasElement }) => {
    const title = canvasElement.querySelector<HTMLElement>("[data-pill-title]")!;
    const value = canvasElement.querySelector<HTMLElement>("[data-pill-value]")!;
    await expect(value.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom - 0.5);
    await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
  },
});

/** A wide half (≥240px): one line, the state word right-aligned, and the
 * summary lists every count. */
export const Wide = Overflow.extend({
  parameters: { stageWidth: 720 },
  play: async ({ canvasElement }) => {
    const title = canvasElement.querySelector<HTMLElement>("[data-pill-title]")!;
    const value = canvasElement.querySelector<HTMLElement>("[data-pill-value]")!;
    const half = title.closest<HTMLElement>(".bk-row-half")!;
    if (half.getBoundingClientRect().width >= 240) {
      await expect(Math.abs(value.getBoundingClientRect().top - title.getBoundingClientRect().top)).toBeLessThan(4);
    } else {
      await expect(value.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom - 0.5);
    }
    await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
  },
});

/** A long title truncates on the pill (opening the session shows it whole);
 * the state word never does. */
export const LongContent = meta.story({
  parameters: { stageWidth: 320 },
  args: { sessions: opens([longWorkingSession, workingByState.queued]) },
  play: async ({ canvasElement }) => {
    for (const value of canvasElement.querySelectorAll<HTMLElement>("[data-pill-value]")) {
      await expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
    }
    const title = canvasElement.querySelector<HTMLElement>("[data-pill-title]")!;
    await expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  },
});

/** No sessions draws nothing, and the row with no other half is absent. */
export const Empty = meta.story({
  args: { sessions: [] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-session-strip]")).toBeNull();
    await expect(canvasElement.querySelector<HTMLElement>("[data-composer-row]")!.getBoundingClientRect().height).toBe(0);
  },
});
