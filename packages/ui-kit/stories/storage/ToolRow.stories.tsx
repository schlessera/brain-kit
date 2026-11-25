import preview from "#.storybook/preview";
import type { Decorator } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import { ToolList, ToolRow, type ToolRowProps } from "../../src/storage/ToolRow.js";
import { overflowing } from "../_stage.js";

/**
 * Storage maintenance tools (#4545), one row per owner-supported tool.
 *
 * Every state is drawn at 320px (stacked) and at the design's 940px desktop
 * column; the two Vitest story projects run each in dark and in paper. The
 * fixture is the Odysseus world on 2026-07-12; tool names and descriptions are
 * the owners' own labels.
 */

const PACK = { name: "Pack Git objects", description: "Pack local objects and refs; history and reflogs remain." };
const SCRATCH = { name: "Prune eligible scratch", description: "Apply existing age/size policy; retained answer pins remain." };
const STAGING = {
  name: "Settled share staging cleanup",
  description: "Clean only owner-approved settled staging; live work and recovery remain protected.",
};

const HEADROOM_OK = { required: { bytes: 2_100_000_000, text: "2.1 GB" }, available: { bytes: 5_900_000_000, text: "5.9 GB" } };
const HEADROOM_SHORT = {
  required: { bytes: 2_100_000_000, text: "2.1 GB" },
  available: { bytes: 1_700_000_000, text: "1.7 GB" },
  shortfall: "0.4 GB",
};

/** Phone width is the 320px viewport less the pane's 12px gutters. */
const PHONE = 320;
const DESKTOP = 940;

/**
 * A fixed-width frame rather than `stage`'s max-width column: the row lays
 * itself out from its own width (a container query), and the story runner's
 * page is narrower than the desktop column, so a max-width would quietly turn
 * every desktop story into a phone one.
 */
const frame: Decorator = (Story, context) => {
  const width = (context.parameters.toolWidth as number | undefined) ?? PHONE;
  const zoom = context.parameters.toolZoom as number | undefined;
  return (
    <div
      data-tool-frame=""
      style={{
        width: zoom ? width / zoom : width,
        zoom,
        boxSizing: "border-box",
        padding: width < 720 ? "0 12px" : 0,
        background: "var(--bk-color-surface)",
      }}
    >
      <Story />
    </div>
  );
};

const desktop = { toolWidth: DESKTOP };

function frameOf(canvasElement: HTMLElement) {
  return canvasElement.querySelector<HTMLElement>("[data-tool-frame]")!;
}

/**
 * The geometry every row story proves: nothing escapes the frame, and the
 * button sits where the design puts it — last and full width when stacked,
 * on the first line, right of the evidence, from 720px.
 */
async function laidOut(canvasElement: HTMLElement) {
  const box = frameOf(canvasElement);
  await expect(overflowing(box), "nothing escapes the row's frame").toEqual([]);
  for (const row of box.querySelectorAll<HTMLElement>("[data-tool-row]")) {
    const result = row.querySelector<HTMLElement>(".bk-tool-result")!.getBoundingClientRect();
    const name = row.querySelector<HTMLElement>(".bk-tool-name")!.getBoundingClientRect();
    const chip = row.querySelector<HTMLElement>(".bk-tool-chip")!.getBoundingClientRect();
    const grid = row.querySelector<HTMLElement>(".bk-tool-row-grid")!.getBoundingClientRect();
    const action = row.querySelector<HTMLElement>(".bk-tool-action");
    const wide = row.getBoundingClientRect().width >= 720;
    if (wide) {
      await expect(result.left, "the result block is its own column").toBeGreaterThan(name.left);
      await expect(chip.left, "the chip sits right of the result").toBeGreaterThanOrEqual(result.right);
    } else {
      await expect(Math.abs(chip.top - name.top), "the chip sits beside the name").toBeLessThan(8);
      await expect(result.left, "stacked: the result starts at the row's edge").toBeCloseTo(grid.left, 0);
    }
    if (!action) continue;
    const button = action.getBoundingClientRect();
    if (wide) {
      await expect(button.left, "desktop: the button is right of the chip").toBeGreaterThanOrEqual(chip.right);
      await expect(button.top, "desktop: the button is on the first line").toBeLessThan(result.bottom);
    } else {
      await expect(button.top, "stacked: the button comes after the evidence").toBeGreaterThanOrEqual(result.bottom);
      await expect(button.width, "stacked: the button is full width").toBeCloseTo(grid.width, 0);
    }
  }
}

/** The quiet tone and its chip: no primary fill, `maintain` named beside it. */
async function quietWithChip(canvasElement: HTMLElement, name: RegExp) {
  const canvas = within(canvasElement);
  const button = canvas.getByRole("button", { name });
  await expect(getComputedStyle(button).backgroundColor, "quiet: no fill").toBe("rgba(0, 0, 0, 0)");
  await expect(button.className, "the target reaches 44px through the hit-area utility").toContain("bk-hit");
  await expect(canvas.getByText("maintain"), "the effect chip").toBeVisible();
  return button;
}

const meta = preview.meta({
  title: "Storage/ToolRow",
  component: ToolRow,
  decorators: [frame],
  parameters: { layout: "padded", toolWidth: PHONE },
  args: { ...PACK, state: "never", onRun: fn(), onCancel: fn(), headroom: HEADROOM_OK } satisfies ToolRowProps,
});

/** No receipt yet. Run is the first action and headroom is drawn from the
 * last pack estimate the caller has. */
export const NeverRun = meta.story({
  play: async ({ canvasElement, args, userEvent }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Never run")).toBeVisible();
    const run = await quietWithChip(canvasElement, /^Run Pack Git objects$/);
    await userEvent.click(run);
    await expect(args.onRun).toHaveBeenCalledTimes(1);
  },
});
export const NeverRunDesktop = NeverRun.extend({ parameters: desktop });

/** Queued behind another job: Cancel is offered, and the headroom stays in view. */
export const Waiting = meta.story({
  args: { state: "waiting", at: "12 Jul 03:08" },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("· queued 12 Jul 03:08", { exact: false })).toBeVisible();
    await expect(canvas.getByText("Starts when the current job finishes")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Cancel Pack Git objects" })).toBeVisible();
  },
});
export const WaitingDesktop = Waiting.extend({ parameters: desktop });

/**
 * Running, with Cancel. Pressing it enters the busy state at once —
 * `Cancelling…`, button disabled — until the receipt moves on. No total is
 * known in advance, so there is no "n of m".
 */
export const Running = meta.story({
  args: { state: "running", at: "03:09" },
  play: async ({ canvasElement, args, userEvent }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Running")).toBeVisible();
    await expect(canvas.getByText("· since 03:09", { exact: false })).toBeVisible();
    await expect(canvas.getByText("Working…")).toBeVisible();
    await expect(canvas.queryByText(/ of /), "no n-of-m progress").toBeNull();
    await expect(canvas.queryByRole("meter"), "the stripe takes the meter's slot").toBeNull();
    await expect(canvasElement.querySelector(".bk-tool-stripe")?.getAttribute("aria-hidden")).toBe("true");
    const cancel = await quietWithChip(canvasElement, /^Cancel Pack Git objects$/);
    await userEvent.click(cancel);
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    const busy = canvas.getByRole("button", { name: "Cancelling Pack Git objects" });
    await expect(busy).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText("Cancelling…", { selector: "[data-tool-state] span" })).toBeVisible();
    busy.click();
    await expect(args.onCancel, "a busy Cancel is inert").toHaveBeenCalledTimes(1);
  },
});
export const RunningDesktop = Running.extend({ parameters: desktop });

/** Only staging cleanup streams items while it runs; when the caller has a
 * count it reads `Working… · {n} done`. */
export const RunningWithCount = meta.story({
  args: { ...STAGING, headroom: undefined, state: "running", at: "03:09", doneCount: 14 },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    await expect(within(canvasElement).getByText("Working… · 14 done")).toBeVisible();
  },
});
export const RunningWithCountDesktop = RunningWithCount.extend({ parameters: desktop });

/** The caller can also hold the busy state itself, e.g. after a reload. */
export const Cancelling = meta.story({
  args: { state: "running", at: "03:09", cancelling: true },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Cancelling Pack Git objects" })).toHaveAttribute("aria-disabled", "true");
  },
});
export const CancellingDesktop = Cancelling.extend({ parameters: desktop });

export const Cancelled = meta.story({
  args: { state: "cancelled", at: "12 Jul 03:10" },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Cancelled")).toBeVisible();
    await expect(canvas.getByText("Stopped before finishing · change not measured")).toBeVisible();
    await quietWithChip(canvasElement, /^Try again Pack Git objects$/);
  },
});
export const CancelledDesktop = Cancelled.extend({ parameters: desktop });

/**
 * Refused for space: the row says its own reason, and the shared "Needs
 * headroom…" paragraph is gone. Try again stays enabled; the server decides.
 */
export const RefusedNoSpace = meta.story({
  args: { state: "refused", at: "12 Jul 03:10", reason: "Not enough available space to pack", headroom: HEADROOM_SHORT },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Refused")).toBeVisible();
    await expect(canvas.getByText("Not enough available space to pack")).toBeVisible();
    await expect(canvasElement.textContent, "no shared headroom paragraph").not.toMatch(/Needs headroom/);
    const retry = await quietWithChip(canvasElement, /^Try again Pack Git objects$/);
    await expect(retry).not.toHaveAttribute("aria-disabled");
  },
});
export const RefusedNoSpaceDesktop = RefusedNoSpace.extend({ parameters: desktop });

/** A measured completion: the delta is the caller's, labelled unattributed,
 * because other writers share the volume. Never "freed" or "saved". */
export const DoneMeasured = meta.story({
  args: { state: "complete", at: "12 Jul 03:10", change: { delta: "+1.8 GB" } },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Done")).toBeVisible();
    await expect(canvas.getByText("Available +1.8 GB · unattributed")).toBeVisible();
    await expect(canvasElement.textContent).not.toMatch(/freed|saved|\bfree\b/i);
  },
});
export const DoneMeasuredDesktop = DoneMeasured.extend({ parameters: desktop });

/** A run can leave less available than before; the sign is the caller's. */
export const DoneMeasuredLess = meta.story({
  args: { ...SCRATCH, headroom: undefined, state: "complete", at: "12 Jul 03:10", change: { delta: "−0.2 GB" } },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    await expect(within(canvasElement).getByText("Available −0.2 GB · unattributed")).toBeVisible();
    await expect(within(canvasElement).queryByText(/Headroom/), "a tool that frees space has no headroom line").toBeNull();
  },
});
export const DoneMeasuredLessDesktop = DoneMeasuredLess.extend({ parameters: desktop });

/** No before observation: the not-measured state with its reason, never
 * `unknown → unknown`. */
export const DoneNotMeasured = meta.story({
  args: { state: "complete", at: "12 Jul 03:10", change: { notMeasured: "before measurement missing" } },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    await expect(within(canvasElement).getByText("Change not measured · before measurement missing")).toBeVisible();
    await expect(canvasElement.textContent).not.toMatch(/unknown|→/);
  },
});
export const DoneNotMeasuredDesktop = DoneNotMeasured.extend({ parameters: desktop });

const REASONS = ["before measurement missing", "after measurement missing", "volume changed", "measurement incomplete"] as const;

/** Each not-measured reason the design names, one row apiece. */
export const NotMeasuredReasons = meta.story({
  render: (args) => (
    <ToolList>
      {REASONS.map((reason) => (
        <ToolRow key={reason} {...args} state="complete" at="12 Jul 03:10" change={{ notMeasured: reason }} />
      ))}
    </ToolList>
  ),
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    for (const reason of REASONS) await expect(within(canvasElement).getByText(`Change not measured · ${reason}`)).toBeVisible();
    await expect(canvasElement.textContent).not.toMatch(/unknown|→/);
  },
});
export const NotMeasuredReasonsDesktop = NotMeasuredReasons.extend({ parameters: desktop });

/** Part of the work done: the non-null counts, then the change line. */
export const Partial = meta.story({
  args: {
    ...SCRATCH,
    headroom: undefined,
    state: "partial",
    at: "12 Jul 03:10",
    counts: { removed: 41, failed: 3, deferred: 2, packed: null },
    change: { notMeasured: "after measurement missing" },
  },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Partly done")).toBeVisible();
    await expect(canvas.getByText("Removed 41 · failed 3 · deferred 2")).toBeVisible();
    await expect(canvas.getByText("Change not measured · after measurement missing")).toBeVisible();
    await quietWithChip(canvasElement, /^Try again Prune eligible scratch$/);
  },
});
export const PartialDesktop = Partial.extend({ parameters: desktop });

export const UnknownOutcome = meta.story({
  args: { state: "unknown", at: "12 Jul 03:10", reason: "the host restarted during the run" },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Outcome unknown")).toBeVisible();
    await expect(canvas.getByText("Couldn't confirm the result · the host restarted during the run")).toBeVisible();
  },
});
export const UnknownOutcomeDesktop = UnknownOutcome.extend({ parameters: desktop });

/** The tool cannot run on this host at all: no button, no meter, the reason. */
export const Unavailable = meta.story({
  args: { available: false, unavailableReason: "Git not installed" },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not available here")).toBeVisible();
    await expect(canvas.getByText("· Git not installed", { exact: false })).toBeVisible();
    await expect(canvas.queryByRole("button"), "nothing to press").toBeNull();
    await expect(canvas.queryByRole("meter"), "availability is not headroom").toBeNull();
  },
});
export const UnavailableDesktop = Unavailable.extend({ parameters: desktop });

/**
 * Enough headroom: the fill runs the whole track (the larger figure) and the
 * 2px marker sits at the share the run needs.
 */
export const HeadroomOk = meta.story({
  args: { state: "complete", at: "12 Jul 03:10", change: { delta: "+1.8 GB" } },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    const meter = canvas.getByRole("meter", { name: "Headroom for Pack Git objects" });
    await expect(meter).toHaveAttribute("aria-valuetext", "needs 2.1 GB, 5.9 GB available");
    await expect(canvas.getByText("needs 2.1 GB · 5.9 GB available")).toBeVisible();
    await expect(canvas.getByText("estimate from last run · not reserved")).toBeVisible();
    const track = meter.getBoundingClientRect();
    const fill = meter.querySelector("[data-tool-meter-fill]")!.getBoundingClientRect();
    const mark = meter.querySelector("[data-tool-meter-mark]")!.getBoundingClientRect();
    await expect(fill.width, "the fill is the whole track").toBeCloseTo(track.width, 0);
    await expect(mark.width).toBe(2);
    await expect((mark.left + 1 - track.left) / track.width, "the marker sits at 2.1 of 5.9").toBeCloseTo(2.1 / 5.9, 2);
    await expect(meter.querySelector("[data-tool-meter-short]")).toBeNull();
  },
});
export const HeadroomOkDesktop = HeadroomOk.extend({ parameters: desktop });

/**
 * Short: the fill stops at what is available and a hatch runs on to the
 * marker. `▲ Short by …` is words, and Run stays enabled (ruling).
 */
export const HeadroomShort = meta.story({
  args: { state: "complete", at: "12 Jul 03:10", change: { notMeasured: "volume changed" }, headroom: HEADROOM_SHORT },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    const meter = canvas.getByRole("meter", { name: "Headroom for Pack Git objects" });
    await expect(meter).toHaveAttribute("aria-valuetext", "Short by 0.4 GB, needs 2.1 GB, 1.7 GB available");
    await expect(canvas.getByText("▲ Short by 0.4 GB · needs 2.1 GB · 1.7 GB available")).toBeVisible();
    const track = meter.getBoundingClientRect();
    const fill = meter.querySelector("[data-tool-meter-fill]")!.getBoundingClientRect();
    const hatch = meter.querySelector("[data-tool-meter-short]")!.getBoundingClientRect();
    await expect(fill.width / track.width, "fill at 1.7 of 2.1").toBeCloseTo(1.7 / 2.1, 2);
    await expect(hatch.left, "the hatch starts where the fill ends").toBeCloseTo(fill.right, 0);
    await expect(hatch.right, "and runs to the marker at the end").toBeCloseTo(track.right, 0);
    // Too small for the visual baseline's tolerance to see, so it is read here.
    await expect(getComputedStyle(meter.querySelector("[data-tool-meter-short]")!).backgroundImage, "short is hatched")
      .toMatch(/^repeating-linear-gradient\(/);
    const run = await quietWithChip(canvasElement, /^Run Pack Git objects$/);
    await expect(run, "short headroom never disables Run").not.toHaveAttribute("aria-disabled");
  },
});
export const HeadroomShortDesktop = HeadroomShort.extend({ parameters: desktop });

/** No estimate yet: a `?` mark in words, no bar at all. */
export const HeadroomWithoutEstimate = meta.story({
  args: { headroom: { required: null, available: { bytes: 5_900_000_000, text: "5.9 GB" } } },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("? · needs an estimate from a measured run")).toBeVisible();
    await expect(canvas.queryByRole("meter"), "an absent figure draws no bar").toBeNull();
    await expect(canvasElement.querySelector(".bk-tool-meter-fill")).toBeNull();
  },
});
export const HeadroomWithoutEstimateDesktop = HeadroomWithoutEstimate.extend({ parameters: desktop });

/** An estimate but no comparable observation of the volume. */
export const HeadroomWithoutObservation = meta.story({
  args: { headroom: { required: { bytes: 2_100_000_000, text: "2.1 GB" }, available: null } },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("? · needs 2.1 GB · available not measured")).toBeVisible();
    await expect(canvas.queryByRole("meter")).toBeNull();
  },
});
export const HeadroomWithoutObservationDesktop = HeadroomWithoutObservation.extend({ parameters: desktop });

/** A per-operation note from the owner replaces the missing-evidence text. */
export const HeadroomNote = meta.story({
  args: {
    ...STAGING,
    headroom: { required: null, available: null, note: "Cleanup receipts need writable capacity; recovery is never discarded to make room." },
  },
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    await expect(within(canvasElement).getByText(/^Cleanup receipts need writable capacity/)).toBeVisible();
  },
});
export const HeadroomNoteDesktop = HeadroomNote.extend({ parameters: desktop });

/**
 * The section: three tools, a rule between rows, one footnote and a polite
 * live region for the latest state change.
 */
export const ListOfThree = meta.story({
  args: {},
  render: () => (
    <ToolList onFindLargeFiles={fn()} announcement="Pack Git objects done. Available up 1.8 gigabytes, unattributed.">
      <ToolRow {...PACK} state="complete" at="12 Jul 03:10" change={{ delta: "+1.8 GB" }} headroom={HEADROOM_OK} onRun={fn()} />
      <ToolRow {...SCRATCH} state="partial" at="12 Jul 02:40" counts={{ removed: 41, failed: 3, deferred: 2 }} change={{ notMeasured: "after measurement missing" }} onRun={fn()} />
      <ToolRow {...STAGING} state="never" onRun={fn()} />
    </ToolList>
  ),
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Free up space" })).toBeVisible();
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
    await expect(canvasElement.querySelectorAll("[data-tool-footnote]"), "one footnote for the section").toHaveLength(1);
    await expect(canvasElement.textContent).not.toMatch(/Needs headroom/);
    await expect(canvas.getByRole("button", { name: "Find large files" })).toBeVisible();
    const live = canvasElement.querySelector("[data-tool-live]")!;
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live.textContent).toBe("Pack Git objects done. Available up 1.8 gigabytes, unattributed.");
    const rows = canvas.getAllByRole("listitem");
    await expect(getComputedStyle(rows[1]!).borderTopStyle, "rows are divided by a rule").toBe("solid");
  },
});
export const ListOfThreeDesktop = ListOfThree.extend({ parameters: desktop });

const EVERY_STATE: ToolRowProps[] = [
  { ...PACK, state: "never", headroom: HEADROOM_OK },
  { ...PACK, state: "waiting", at: "12 Jul 03:08" },
  { ...PACK, state: "running", at: "03:09" },
  { ...STAGING, state: "running", at: "03:09", doneCount: 14 },
  { ...PACK, state: "running", at: "03:09", cancelling: true },
  { ...PACK, state: "complete", at: "12 Jul 03:10", change: { delta: "+1.8 GB" }, headroom: HEADROOM_OK },
  { ...PACK, state: "complete", at: "12 Jul 03:10", change: { notMeasured: "volume changed" }, headroom: HEADROOM_SHORT },
  { ...SCRATCH, state: "complete", at: "12 Jul 03:10", change: { delta: "−0.2 GB" } },
  { ...SCRATCH, state: "partial", at: "12 Jul 03:10", counts: { removed: 41, failed: 3, deferred: 2 } },
  { ...PACK, state: "refused", at: "12 Jul 03:10", reason: "Not enough available space to pack", headroom: { required: null, available: HEADROOM_OK.available } },
  { ...PACK, state: "cancelled", at: "12 Jul 03:10", headroom: { required: HEADROOM_OK.required, available: null } },
  { ...PACK, state: "unknown", at: "12 Jul 03:10", reason: "the host restarted during the run" },
  { ...STAGING, state: "never", available: false, unavailableReason: "no inbox owner on this host" },
];

const EVERY_STATE_LINES = [
  "○Never run",
  "◌Waiting · queued 12 Jul 03:08",
  "◐Running · since 03:09",
  "◐Running · since 03:09",
  "◌Cancelling…",
  "●Done · 12 Jul 03:10",
  "●Done · 12 Jul 03:10",
  "●Done · 12 Jul 03:10",
  "◑Partly done · 12 Jul 03:10",
  "⊘Refused · 12 Jul 03:10",
  "◇Cancelled · 12 Jul 03:10",
  "?Outcome unknown · 12 Jul 03:10",
  "⊘Not available here · no inbox owner on this host",
];

function everyState() {
  return (
    <ToolList onFindLargeFiles={fn()}>
      {EVERY_STATE.map((row, index) => (
        <ToolRow key={index} {...row} onRun={fn()} onCancel={fn()} />
      ))}
    </ToolList>
  );
}

/** Every state in one list: the visual baseline's subject at each width. */
export const EveryState = meta.story({
  render: everyState,
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const states = [...canvasElement.querySelectorAll("[data-tool-state]")].map((el) => el.textContent);
    await expect(states).toEqual(EVERY_STATE_LINES);
  },
});
export const EveryStateDesktop = EveryState.extend({ parameters: desktop });

/**
 * Every state with the hue removed. What is left is the glyph's shape, the
 * word, the hatch and the marker, and those are what the assertions read.
 */
export const Greyscale = meta.story({
  render: () => <div style={{ filter: "grayscale(1)" }}>{everyState()}</div>,
  play: async ({ canvasElement }) => {
    await laidOut(canvasElement);
    const states = [...canvasElement.querySelectorAll("[data-tool-state]")].map((el) => el.textContent);
    await expect(states).toEqual(EVERY_STATE_LINES);
    await expect(canvasElement.querySelector("[data-tool-meter-short]"), "short is a hatch, not only a hue").not.toBeNull();
    await expect(canvasElement.querySelector("[data-tool-meter-mark]"), "the estimate is a marker").not.toBeNull();
  },
});
export const GreyscaleDesktop = Greyscale.extend({ parameters: desktop });

/**
 * 200% zoom at 320px: the row lays out in 160 CSS pixels and paints at 320.
 * Everything wraps; nothing scrolls sideways and the button stays reachable.
 */
export const Zoom200 = meta.story({
  args: { state: "refused", at: "12 Jul 03:10", reason: "Not enough available space to pack", headroom: HEADROOM_SHORT },
  parameters: { toolZoom: 2 },
  play: async ({ canvasElement }) => {
    const box = frameOf(canvasElement);
    await expect(getComputedStyle(box).zoom).toBe("2");
    await laidOut(canvasElement);
    await expect(box.scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(box.clientWidth);
    await expect(within(canvasElement).getByRole("button", { name: "Try again Pack Git objects" })).toBeVisible();
  },
});
