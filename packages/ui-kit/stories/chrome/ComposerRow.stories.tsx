import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { WORKING_NOW, ogygiaClock, workingByState } from "../../fixtures/sessions.js";
import { ComposerRow } from "../../src/chrome/ComposerRow.js";
import { PendingFollowUps } from "../../src/chrome/PendingFollowUps.js";
import { SessionStrip, type WorkingSession } from "../../src/chrome/SessionStrip.js";
import { stage } from "../_stage.js";

const working: WorkingSession[] = [workingByState["needs-you"], workingByState.running, workingByState.done, workingByState.queued].map((s) => ({ ...s, onOpen: fn() }));

/** The right half: pending follow-ups for the open session (#1002). */
function Pending({ labels, keyboardOpen }: { labels: string[]; keyboardOpen?: boolean }) {
  return <PendingFollowUps followUps={labels.map((label, i) => ({ id: `follow-up:${i}`, label, text: label }))} keyboardOpen={keyboardOpen} />;
}

interface Scene { working: number; pending: string[]; keyboardOpen?: boolean }

/** `ComposerRow` with a `SessionStrip` on the left and pending stand-ins on the right. */
function RowScene(s: Scene) {
  return (
    <ComposerRow
      left={<SessionStrip sessions={working.slice(0, s.working)} now={WORKING_NOW} formatClock={ogygiaClock} keyboardOpen={s.keyboardOpen} />}
      right={<Pending labels={s.pending} keyboardOpen={s.keyboardOpen} />}
    />
  );
}

const meta = preview.meta({
  title: "Chrome/ComposerRow",
  component: RowScene,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: { working: 4, pending: ["Also the April receipts"] },
});

function halves(root: HTMLElement) {
  const [left, right] = [...root.querySelectorAll<HTMLElement>("[data-row-half]")].map((el) => el.getBoundingClientRect());
  return { left: left!, right: right!, row: root.querySelector<HTMLElement>("[data-composer-row]")!.getBoundingClientRect() };
}

/** Both halves populated at 320: two-line pills, an 8px gutter, 94px tall. */
export const BothHalves320 = meta.story({
  play: async ({ canvasElement }) => {
    const { left, right, row } = halves(canvasElement);
    await expect(right.left - left.right).toBeGreaterThanOrEqual(8);
    await expect(row.height).toBe(94);
    // Bottom-aligned: the lone pending pill sits on the composer edge.
    const pending = canvasElement.querySelector<HTMLElement>('[aria-label="Pending follow-ups"] [data-pill]')!;
    await expect(pending.getBoundingClientRect().bottom).toBe(row.bottom);
  },
});

export const BothHalves390 = BothHalves320.extend({ parameters: { stageWidth: 390 } });

/** 900: a 720px measure, so each half is 356px and pills draw one line. */
export const BothHalves900 = BothHalves320.extend({ parameters: { stageWidth: 900 } });

/** Only pending: the left column paints nothing and keeps its place, so the
 * right pill stays right. This is also the ≥1280 row, where the working
 * sessions live in the Sessions pane. */
export const LeftEmpty = meta.story({
  args: { working: 0, pending: ["Check the April receipts too", "And the harbour dues"] },
  play: async ({ canvasElement }) => {
    const { right, row } = halves(canvasElement);
    await expect(right.right).toBe(row.right);
    await expect(canvasElement.querySelector('[data-row-half="left"]')!.childElementCount).toBe(0);
  },
});

/** Only working sessions: the right column stays empty. */
export const RightEmpty = meta.story({ args: { working: 2, pending: [] } as Scene });

/** Keyboard up: each populated half collapses to one 44px summary, side by side. */
export const KeyboardUp = meta.story({
  args: { working: 3, pending: ["Also the April receipts"], keyboardOpen: true },
  play: async ({ canvasElement }) => {
    const { left, right, row } = halves(canvasElement);
    await expect(row.height).toBe(44);
    await expect(right.left - left.right).toBeGreaterThanOrEqual(8);
    const pending = canvasElement.querySelector<HTMLElement>("[data-pending-summary]")!.getBoundingClientRect();
    await expect(pending.height).toBe(44);
    await expect(pending.left).toBeGreaterThanOrEqual(right.left);
  },
});

/** Both halves empty: the row is absent, with no spacer. */
export const Absent = meta.story({
  args: { working: 0, pending: [] },
  play: async ({ canvasElement }) => {
    await expect(halves(canvasElement).row.height).toBe(0);
  },
});
