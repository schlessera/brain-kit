import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { queueItems } from "../../fixtures/actions.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import type { QueueState } from "../../src/types.js";
import { stage, wide } from "../_stage.js";
import { Handoff, playHandoff } from "../_ghost.js";

const STATES: QueueState[] = ["claimed", "blocked", "ready", "scheduled", "failed", "superseded"];

const meta = preview.meta({
  title: "Rows/QueueItemRow",
  component: QueueItemRow,
  decorators: [stage],
  args: {
    view: "ready",
    state: "blocked",
    subject: "edit · voyage/_index.md",
    meta: "4m",
    link: "waiting on your approval",
    onClick: fn(),
  },
  argTypes: {
    view: { control: "select", options: ["ready", "loading", "empty", "error"] },
    state: { control: "select", options: STATES },
  },
});

export const Default = meta.story({});

/**
 * All six states, from one night's queue. Only `blocked` and `failed` colour
 * their own shell; the other four take the plain card hairline, which is what
 * keeps the two that need you visible.
 */
export const States = meta.story({
  render: (args) => (
    <>
      {queueItems.map((item) => (
        <QueueItemRow {...args} link={undefined} key={item.subject + item.state} {...item} />
      ))}
    </>
  ),
  play: async ({ canvas, canvasElement }) => {
    const rows = Array.from(canvasElement.querySelectorAll<HTMLElement>('[role="button"]'));
    await expect(rows).toHaveLength(queueItems.length);
    for (const [index, item] of queueItems.entries()) {
      await expect(rows[index]).toHaveTextContent(item.subject);
      await expect(rows[index]).toHaveTextContent(item.state);
      if (item.link) await expect(rows[index]).toHaveTextContent(item.link);
      else await expect(rows[index]).not.toHaveTextContent("waiting on your approval");
    }
    await expect(await canvas.findAllByText("waiting on your approval")).toHaveLength(1);
  },
});

/** `claimed` is the one state that breathes: an agent is holding a lease. */
export const Claimed = Default.extend({
  args: { state: "claimed", subject: "index · omens/", meta: "lease 40s", note: "held by note-filer", link: undefined },
});

export const Failed = Default.extend({
  args: {
    state: "failed",
    subject: "fetch · winds.example.invalid",
    meta: "2h",
    note: "dead-lettered after 3 attempts",
    link: undefined,
  },
});

/**
 * Superseded work is still shown, held back rather than deleted: it is the
 * evidence that the queue did the right thing.
 *
 * It USED to be held back with `opacity: .7`, which renders the row to a layer
 * and composites the WHOLE thing against the canvas — text and ground together
 * — so ink-mute arrived at 3.08:1 and the teal that means something at 4.17:1
 * (design-feedback §4). The design's answer was not a brighter ink but no fade
 * at all: "a superseded row is not lower-contrast. It reads as superseded from
 * its state word and its still, neutral dot, at full ink contrast." This story
 * carries no contrast exception any more, which is the assertion.
 */
export const Superseded = Default.extend({
  args: {
    state: "superseded",
    subject: "edit · voyage/_index.md",
    meta: "6h",
    note: "replaced by a later edit to the same field",
    link: undefined,
  },
});

export const Wide = Default.extend({ parameters: wide });

/* ── The Placeholder delegation, all four states ───────────────────────── */

export const Loading = Default.extend({ args: { view: "loading" } });

export const Empty = Default.extend({ args: { view: "empty" } });

export const ErrorState = Default.extend({ args: { view: "error", onStateAction: fn() } });

export const EmptyOverridden = Default.extend({
  args: { view: "empty", stateMessage: "Nothing claimed since landfall", stateDetail: "Last drain 06:40." },
});

export const Retried = ErrorState.extend({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Retry"));
    await expect(args.onStateAction).toHaveBeenCalled();
  },
});

export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const row = await canvas.findByRole("button");
    await userEvent.click(row);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    row.focus();
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
});

/** THE CONTRACT. The queue is read-only on most screens, and a read-only row
 * carries no role, no tab stop and no hover. */
export const Static = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

/**
 * Loading → ready (#1116). Ghost text in the row's own frame: the state word
 * and subject as mono ghosts, an `edge` dot until the state is known, and the
 * blocked row's amber shell only once the data says it is blocked. Each row
 * hands off when its own data lands, in 600ms; nothing below it moves.
 */
export const LoadingToReady = meta.story({
  parameters: wide,
  render: () => (
    <Handoff
      render={(loading) => (
        <QueueItemRow view={loading ? "loading" : "ready"} state="blocked" subject="edit · voyage/_index.md" meta="4m" />
      )}
    />
  ),
  play: playHandoff,
});
