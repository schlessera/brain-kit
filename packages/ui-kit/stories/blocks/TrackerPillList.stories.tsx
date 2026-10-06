import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import {
  trackerEveryAction,
  trackerLongest,
  trackerLongHost,
  trackerMixed,
  trackerTwenty,
} from "../../fixtures/tracker.js";
import { TrackerPillList } from "../../src/blocks/TrackerPillList.js";
import { overflowing, stage, wide } from "../_stage.js";

/** The chat column on a 320px phone: the viewport less two 16px gutters. */
const phone = { stageWidth: 288 };

const meta = preview.meta({
  title: "Blocks/TrackerPillList",
  component: TrackerPillList,
  decorators: [stage],
  parameters: phone,
  args: { events: trackerMixed },
});

/**
 * The list the issue asks for at phone width: an issue opened, a pull request
 * merged, an issue closed with a reason, a withheld address and a tracker
 * that is not GitHub. The host and repository sit in run headers, derived from
 * each url; every pill is one line, and the withheld one is not a link.
 */
export const Mixed = meta.story({
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("link", { name: "Open pull request ithaca/hall 21 on github.com, merged" })).toHaveAttribute(
      "href",
      "https://github.com/ithaca/hall/pull/21"
    );
    await expect(canvas.getByRole("link", { name: "Open tracker.ogygia-shipyard.example, opened" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("link")).toHaveLength(4);
    await expect(canvas.getByText("1 address withheld: the address carries a sign-in name or password.")).toBeInTheDocument();
    for (const pill of canvasElement.querySelectorAll<HTMLElement>("[data-tracker-pill]")) {
      await expect(pill.getBoundingClientRect().height).toBe(36);
    }
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});

export const MixedWide = Mixed.extend({ parameters: wide });

/**
 * Every action, and every qualifier the tone table names. The action is a
 * printed word on every pill; the tone and its mark only back it up.
 */
export const EveryAction = meta.story({
  args: { events: trackerEveryAction, expanded: true },
  play: async ({ canvasElement }) => {
    const actions = [...canvasElement.querySelectorAll("[data-tracker-action]")].map((el) => el.textContent);
    await expect(actions).toEqual([
      "opened",
      "closed completed",
      "closed not planned",
      "closed duplicate",
      "reopened",
      "merged",
      "labeled household",
      "commented",
      "reviewed approved",
      "reviewed changes requeste…",
      "reviewed",
    ]);
  },
});

/** A refused address: a dashed pill with no anchor, no open glyph and no tab stop, and its reason once in the foot. */
export const Withheld = meta.story({
  args: { events: [trackerMixed[3]!, trackerMixed[0]!] },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(canvas.getAllByRole("link")).toHaveLength(1);
    await userEvent.tab();
    await expect(document.activeElement).toBe(canvas.getByRole("link"));
    await expect(canvasElement.querySelector("[data-tracker-withheld] [data-tracker-open]")).toBeNull();
  },
});

/**
 * Twenty changes, the most a block carries. Five show, then `Show all 20
 * changes`; expanding keeps focus on the control, whose label turns to `Show
 * fewer`, and Tab walks on into the newly shown pills.
 */
export const Twenty = meta.story({
  args: { events: trackerTwenty },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(canvasElement.querySelectorAll("[data-tracker-pill]")).toHaveLength(5);
    const more = canvas.getByRole("button", { name: "Show all 20 changes" });
    await userEvent.click(more);
    await expect(document.activeElement).toBe(more);
    await expect(more).toHaveTextContent("Show fewer");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(canvasElement.querySelectorAll("[data-tracker-pill]")).toHaveLength(20);
    await userEvent.tab();
    await expect(document.activeElement).toBe(canvasElement.querySelectorAll("[data-tracker-pill]")[5]);
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});

export const TwentyWide = Twenty.extend({ parameters: wide });

/**
 * The widest fixed part a pill has, with a 200-character title: the action,
 * the cut qualifier and `PR 1234` stay whole and the title gives way, down to
 * its ellipsis.
 */
export const Longest = meta.story({
  args: { events: [trackerLongest] },
  play: async ({ canvasElement }) => {
    const pill = canvasElement.querySelector<HTMLElement>("[data-tracker-pill]")!;
    await expect(pill.getBoundingClientRect().height).toBe(36);
    for (const part of pill.querySelectorAll<HTMLElement>("[data-tracker-action], [data-tracker-number]")) {
      await expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth);
    }
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});

/** A host longer than the column wraps after a dot and is never cut. */
export const LongHost = meta.story({
  args: { events: [trackerLongHost] },
  play: async ({ canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>("[data-tracker-host]")!;
    await expect(host.textContent).toBe("issues.records.harbour-master.palace-of-odysseus.ithaca.gov.example");
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});
