import { useState } from "react";

import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { VolumeCard, VolumeGroup, type VolumeGroupItem } from "../../src/storage/VolumeCard.js";
import { CONTROL_RING, overflowing, ring, stage } from "../_stage.js";
import * as v from "./_volumes.js";

/**
 * One capacity scope as a card, and the cards as the selector for the chart
 * below them (#4542, epic #4537 D3/D5/D7). Every state renders at 320px and
 * at desktop width; both Storybook projects run each story in dark and on
 * paper.
 */
const meta = preview.meta({
  title: "Storage/VolumeCard",
  component: VolumeCard,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: { ...v.ok, thresholds: v.THRESHOLDS, format: v.formatBytes },
});

/** A desktop card is a third of a 940px strip at most; alone it gets the 300px a three-up row gives it. */
const desktop = { parameters: { stageWidth: 300 } };

export const Ok = meta.story({
  play: async ({ canvas }) => {
    await expect(canvas.getByText("OK")).toBeVisible();
    await expect(canvas.getByText("48.2 GB")).toBeVisible();
    await expect(canvas.getByText("available of 250 GB")).toBeVisible();
  },
});
export const OkDesktop = Ok.extend(desktop);

export const Low = meta.story({ args: { ...v.low } });
export const LowDesktop = Low.extend(desktop);

export const VeryLow = meta.story({ args: { ...v.veryLow } });
export const VeryLowDesktop = VeryLow.extend(desktop);

/**
 * Capacity was never reported: "?" for the figure, the gauge's text mark in
 * place of a bar, and Trend and Runway say unknown rather than zero.
 */
export const Unknown = meta.story({
  args: { ...v.unknown, capacity: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Not measured")).toBeVisible();
    await expect(canvas.getByText("Capacity not measured · statfs unavailable")).toBeVisible();
    await expect(canvas.queryByRole("meter")).toBeNull();
    await expect(canvasElement.querySelector("[data-segment], [data-tick]")).toBeNull();
    await expect(canvas.getAllByText("unknown")).toHaveLength(2);
  },
});
export const UnknownDesktop = Unknown.extend(desktop);

/** Out of date: the last status and values are kept, with a clock and the age. */
export const Stale = meta.story({
  args: { ...v.stale },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Measured 3 h ago · out of date")).toBeVisible();
    await expect(canvas.getByText("Low")).toBeVisible();
    await expect(getComputedStyle(canvas.getByRole("meter")).outlineStyle).toBe("dashed");
  },
});
export const StaleDesktop = Stale.extend(desktop);

export const ScopeChanged = meta.story({
  args: { ...v.scopeChanged },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Scope changed 12 Jul 09:10 · earlier history is a different volume")).toBeVisible();
    await expect(canvas.getByText("not projected · scope changed")).toBeVisible();
  },
});
export const ScopeChangedDesktop = ScopeChanged.extend(desktop);

/** The scope couldn't be identified: no figure, no bar, no Trend or Runway. */
export const WriteRefused = meta.story({
  args: { ...v.writeRefused, trend: undefined, runway: undefined, stores: undefined, capacity: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Write refused 12 Jul 14:02 · couldn't tell which volume")).toBeVisible();
    await expect(canvas.queryByRole("meter")).toBeNull();
    await expect(canvasElement.querySelector("[data-capacity-unknown], [data-segment], dl")).toBeNull();
  },
});
export const WriteRefusedDesktop = WriteRefused.extend(desktop);

/**
 * A long name wraps to two lines and then ellipsises. The full name stays
 * the radio's accessible name and its `title`.
 */
export const LongName = meta.story({
  args: { ...v.longName, onSelect: fn(), selected: false },
  play: async ({ canvas, canvasElement }) => {
    const radio = canvas.getByRole("radio", { name: v.longName.name });
    await expect(radio).toHaveAttribute("title", v.longName.name);
    const name = canvasElement.querySelector<HTMLElement>("[data-volume-name]")!;
    await expect(name.getBoundingClientRect().height).toBeLessThanOrEqual(36.5);
    await expect(name.scrollHeight).toBeGreaterThan(name.clientHeight);
    await expect(overflowing(canvasElement.querySelector<HTMLElement>("[data-volume-card]")!)).toEqual([]);
  },
});
export const LongNameDesktop = LongName.extend(desktop);

/**
 * Selected: a filled radio mark and a 2px edge. Focus is a separate ring 2px
 * outside the card, so focused and selected never look alike.
 */
export const Selected = meta.story({
  args: { ...v.low, selected: true, onSelect: fn() },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const radio = canvas.getByRole("radio", { name: "Data volume" });
    await expect(radio).toHaveAttribute("aria-checked", "true");
    await expect(radio).toHaveAccessibleDescription("Low, 16.4 GB available of 161 GB");
    const card = canvasElement.querySelector<HTMLElement>("[data-volume-card]")!;
    await expect(getComputedStyle(card).borderTopWidth).toBe("1px");
    await expect(getComputedStyle(card).boxShadow).toContain("inset");
    await userEvent.tab();
    await expect(document.activeElement).toBe(radio);
    await expect(ring(radio)).toEqual(CONTROL_RING);
  },
});
export const SelectedDesktop = Selected.extend(desktop);

/**
 * Pointer, Enter and Space all select a card. The radio layer covers the
 * whole card, so a pointer anywhere on it, the headline included, lands on
 * the radio.
 */
export const SelectsByPointerEnterAndSpace = meta.story({
  args: { ...v.low, selected: false, onSelect: fn() },
  play: async ({ canvas, args, userEvent }) => {
    const radio = canvas.getByRole("radio", { name: "Data volume" });
    for (const text of ["16.4 GB", "Trend", "Data volume"]) {
      const r = canvas.getByText(text).getBoundingClientRect();
      await expect(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), text).toBe(radio);
    }
    await userEvent.click(radio);
    await expect(args.onSelect).toHaveBeenCalledTimes(1);
    radio.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onSelect).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    await expect(args.onSelect).toHaveBeenCalledTimes(3);
  },
});

/**
 * The stores line ellipsises, and opens the full list. The button reaches
 * 44px under a coarse pointer through the shared hit-area utility.
 */
export const StoresOnDemand = meta.story({
  args: { ...v.longName },
  play: async ({ canvas, userEvent }) => {
    const button = canvas.getByRole("button", { name: /^6 stores/ });
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button.classList.contains("bk-hit")).toBe(true);
    await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    const list = document.getElementById(button.getAttribute("aria-controls")!)!;
    await expect(list).not.toBeVisible();
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(list).toBeVisible();
    await expect(list.querySelectorAll("li")).toHaveLength(6);
  },
});
export const StoresOnDemandDesktop = StoresOnDemand.extend(desktop);

function SelectableGroup(p: { volumes: readonly VolumeGroupItem[]; initial?: string; onSelect?: (id: string) => void }) {
  const [selected, setSelected] = useState(p.initial);
  return (
    <VolumeGroup
      volumes={p.volumes}
      selected={selected}
      thresholds={v.THRESHOLDS}
      format={v.formatBytes}
      onSelect={(id) => {
        setSelected(id);
        p.onSelect?.(id);
      }}
    />
  );
}

const radios = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="radio"]')];

/**
 * Three volumes, stacked at 320px. The group is one `radiogroup`: Tab
 * enters at the selected card, the arrows move the selection and wrap,
 * Home and End go to the ends, and Tab then leaves through the selected
 * card's stores button only.
 */
export const Group = meta.story({
  args: { onSelect: fn() },
  render: (args) => <SelectableGroup volumes={v.group} initial="data" onSelect={args.onSelect as (id: string) => void} />,
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const group = canvas.getByRole("radiogroup", { name: "Volumes" });
    const [data, system, app] = radios(canvasElement);
    await expect(canvasElement.querySelectorAll('[role="radio"][tabindex="0"]')).toHaveLength(1);
    await expect(data).toHaveAttribute("tabindex", "0");

    // One column: each card spans the group and stacks below the last.
    const cards = [...group.querySelectorAll<HTMLElement>("[data-volume-card]")];
    const rects = cards.map((c) => c.getBoundingClientRect());
    for (const r of rects) await expect(Math.abs(r.width - group.getBoundingClientRect().width)).toBeLessThan(1);
    await expect(rects[1]!.top - rects[0]!.bottom).toBeCloseTo(8, 0);
    await expect(getComputedStyle(canvasElement.querySelector(".bk-volume-notch")!).display).toBe("none");

    await userEvent.tab();
    await expect(document.activeElement).toBe(data);
    await expect(ring(data!)).toEqual(CONTROL_RING);
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(system);
    await expect(system).toHaveAttribute("aria-checked", "true");
    await expect(args.onSelect).toHaveBeenLastCalledWith("system");
    await userEvent.keyboard("{ArrowRight}");
    await expect(app).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowDown}");
    await expect(data).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{End}");
    await expect(app).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Home}");
    await expect(data).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowUp}");
    await expect(app).toHaveAttribute("aria-checked", "true");
    await expect(canvasElement.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1);

    // Tab leaves through the selected card's stores button, not every card's.
    await userEvent.tab();
    await expect(document.activeElement).toBe(canvas.getByRole("button", { name: /^2 stores · Voyage transcripts/ }));
    await expect(group.contains(document.activeElement)).toBe(true);
    await userEvent.tab();
    await expect(group.contains(document.activeElement)).toBe(false);

    // A pointer selects, and Tab comes back to the new selection.
    await userEvent.click(system!);
    await expect(system).toHaveAttribute("aria-checked", "true");
    await expect(system).toHaveAttribute("tabindex", "0");
  },
});

/**
 * The same three side by side at desktop width: `auto-fit, minmax(260px,
 * 1fr)` gives three to a row with a 12px gap, and the selected card's notch
 * points down at the chart.
 */
export const GroupDesktop = meta.story({
  // The 12px below is where the chart's heading would start; it keeps the notch in frame.
  render: () => (
    <div style={{ width: "100%", paddingBottom: 12 }}>
      <SelectableGroup volumes={v.group} initial="data" />
    </div>
  ),
  parameters: { stageWidth: 940 },
  play: async ({ canvasElement }) => {
    const cards = [...canvasElement.querySelectorAll<HTMLElement>("[data-volume-card]")].map((c) => c.getBoundingClientRect());
    await expect(new Set(cards.map((r) => Math.round(r.top))).size).toBe(1);
    await expect(cards[1]!.left - cards[0]!.right).toBeCloseTo(12, 0);
    for (const r of cards) await expect(r.width).toBeGreaterThanOrEqual(260);
    const notch = canvasElement.querySelector<HTMLElement>(".bk-volume-notch")!;
    await expect(getComputedStyle(notch).display).toBe("block");
    await expect(notch.getBoundingClientRect().bottom).toBeGreaterThan(cards[0]!.bottom);
  },
});

/** Two volumes at a width where two fit: `auto-fit` stretches them rather than leaving an empty third column. */
export const GroupOfTwoDesktop = meta.story({
  render: () => <SelectableGroup volumes={v.group.slice(0, 2)} initial="system" />,
  parameters: { stageWidth: 940 },
  play: async ({ canvasElement }) => {
    const cards = [...canvasElement.querySelectorAll<HTMLElement>("[data-volume-card]")].map((c) => c.getBoundingClientRect());
    await expect(cards[1]!.right - cards[0]!.left).toBeCloseTo(940, 0);
  },
});

/** Every state at once, for review and the visual baseline. */
const ALL: VolumeGroupItem[] = [
  { id: "ok", ...v.ok },
  { id: "low", ...v.low },
  { id: "very-low", ...v.veryLow },
  { id: "unknown", ...v.unknown },
  { id: "stale", ...v.stale },
  { id: "scope", ...v.scopeChanged },
  { id: "refused", ...v.writeRefused },
  { id: "long", ...v.longName },
];

export const AllStates = meta.story({ render: () => <SelectableGroup volumes={ALL} initial="low" /> });
export const AllStatesDesktop = AllStates.extend({ parameters: { stageWidth: 940 } });

/**
 * Every state at 320px, as a review sheet: three 320px columns side by side,
 * so the whole set fits one screen for the visual baseline. Each column is
 * its own group at phone width, so each stacks as a phone does.
 */
export const PhoneSheet = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <div data-phone-sheet="" style={{ display: "flex", alignItems: "flex-start", gap: 24 }}>
      {[ALL.slice(0, 3), ALL.slice(3, 6), ALL.slice(6)].map((column, i) => (
        <div key={i} style={{ width: 320, flex: "none" }}>
          <SelectableGroup volumes={column} initial="low" />
        </div>
      ))}
    </div>
  ),
});

/**
 * Greyscale: every status reads from its word and glyph shape, selection
 * from the radio mark and edge, and the segments from their pattern.
 */
export const Greyscale = meta.story({
  parameters: { stageWidth: 940 },
  render: () => (
    <div style={{ filter: "grayscale(1)", width: "100%" }}>
      <SelectableGroup volumes={ALL} initial="low" />
    </div>
  ),
});

/**
 * 200% zoom at 320px is a 160px layout viewport. The cards keep one column,
 * every line wraps, and nothing scrolls sideways.
 */
export const Zoom200At320 = meta.story({
  render: () => <SelectableGroup volumes={ALL} initial="low" />,
  parameters: { stageWidth: 160 },
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector<HTMLElement>(".bk-volume-group")!;
    await expect(root.getBoundingClientRect().width).toBeCloseTo(160, 0);
    await expect(overflowing(root)).toEqual([]);
    for (const card of root.querySelectorAll<HTMLElement>("[data-volume-card]")) {
      await expect(overflowing(card)).toEqual([]);
    }
  },
});
