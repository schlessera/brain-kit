import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { CapacityGauge } from "../../src/storage/CapacityGauge.js";
import { overflowing, stage } from "../_stage.js";
import { DATA_LOW, DATA_VERY_LOW, SYSTEM_OK, THRESHOLDS, formatBytes } from "./_volumes.js";

/**
 * One capacity scope's track: used → reserved → available against total,
 * with the Low and Very low ticks drawn where the thresholds put them
 * (#4542, epic #4537 D5). Every state renders at 320px (296px of content,
 * the phone card's track) and at desktop width; both Storybook projects run
 * each story in dark and on paper.
 */
const meta = preview.meta({
  title: "Storage/CapacityGauge",
  component: CapacityGauge,
  decorators: [stage],
  parameters: { stageWidth: 296 },
  args: { capacity: SYSTEM_OK, thresholds: THRESHOLDS, format: formatBytes, level: "ok" as const },
});

const desktop = { parameters: { stageWidth: 940 } };

/** A segment's box, the track's box, and their ratio from the used end. */
function measure(root: HTMLElement) {
  const track = root.querySelector<HTMLElement>('[role="meter"]')!;
  const box = track.getBoundingClientRect();
  const at = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (r.left + r.width / 2 - box.left) / box.width;
  };
  return { track, box, at };
}

export const Known = meta.story({
  play: async ({ canvasElement }) => {
    const { track } = measure(canvasElement);
    await expect(track).toHaveAttribute("aria-valuetext", "48.2 GB available of 250 GB");
    await expect(track).toHaveAccessibleDescription("Low below 25 GB (10%), very low below 12.5 GB (5%)");
  },
});
export const KnownDesktop = Known.extend(desktop);

export const Low = meta.story({ args: { capacity: DATA_LOW, level: "low" } });
export const LowDesktop = Low.extend(desktop);

export const VeryLow = meta.story({ args: { capacity: DATA_VERY_LOW, level: "very-low" } });
export const VeryLowDesktop = VeryLow.extend(desktop);

/**
 * THE ACCEPTANCE GEOMETRY. On a used → reserved → available track, 10% and
 * 5% available sit at 90% and 95% from the used end (266.4px and 281.2px on
 * the 296px track), wherever the available segment happens to end. The
 * meter's valuetext is the brief's sentence, and the description keeps both
 * thresholds in bytes at this width.
 */
const BRIEF_TICKS_PX: Record<number, [number, number]> = { 296: [266.4, 281.2], 260: [234, 247] };

export const TickGeometry = meta.story({
  args: { capacity: DATA_LOW, level: "low" },
  play: async ({ canvasElement }) => {
    const { track, box, at } = measure(canvasElement);
    // The brief's measurements, per track width.
    const expected = BRIEF_TICKS_PX[Math.round(box.width)];
    await expect(expected, `a ${box.width}px track has brief measurements`).toBeDefined();
    const low = track.querySelector('[data-tick="low"]')!;
    const veryLow = track.querySelector('[data-tick="very-low"]')!;
    await expect(at(low)).toBeCloseTo(0.9, 2);
    await expect(at(veryLow)).toBeCloseTo(0.95, 2);
    await expect(Math.abs(at(low) * box.width - expected![0])).toBeLessThan(0.75);
    await expect(Math.abs(at(veryLow) * box.width - expected![1])).toBeLessThan(0.75);

    // The segments run used → reserved → available, butt end to end, and fill the track.
    const segments = [...track.querySelectorAll<HTMLElement>("[data-segment]")];
    await expect(segments.map((s) => s.dataset.segment)).toEqual(["used", "reserved", "available"]);
    let edge = box.left;
    for (const s of segments) {
      const r = s.getBoundingClientRect();
      await expect(r.width).toBeGreaterThan(0);
      await expect(Math.abs(r.left - edge)).toBeLessThan(0.75);
      edge = r.right;
    }
    await expect(Math.abs(edge - box.right)).toBeLessThan(0.75);

    // Low is one rule, Very low a pair: the shape tells them apart, not colour.
    await expect(low.children).toHaveLength(1);
    await expect(veryLow.children).toHaveLength(2);

    await expect(track).toHaveAttribute("aria-valuetext", "16.4 GB available of 161 GB");
    await expect(track).toHaveAccessibleDescription("Low below 16.1 GB (10%), very low below 8.05 GB (5%)");
    await expect(canvasElement.querySelector('[data-threshold-caption="merged"]')).toBeTruthy();
  },
});

/** The same claim on a desktop card's 260px track: 234px and 247px. */
export const TickGeometryCard = TickGeometry.extend({ parameters: { stageWidth: 260 } });

/**
 * Tick positions come from props. With thresholds of 30% and 20% the ticks
 * move to 70% and 80%, and at 940px there is room to label each at its own
 * tick.
 */
export const ThresholdsFromProps = meta.story({
  args: { capacity: DATA_LOW, level: "low", thresholds: { low: 0.3, veryLow: 0.2 } },
  parameters: { stageWidth: 940 },
  play: async ({ canvasElement }) => {
    const { track, at } = measure(canvasElement);
    await expect(at(track.querySelector('[data-tick="low"]')!)).toBeCloseTo(0.7, 2);
    await expect(at(track.querySelector('[data-tick="very-low"]')!)).toBeCloseTo(0.8, 2);
    await expect(canvasElement.querySelector('[data-threshold-caption="split"]')).toBeTruthy();
  },
});

/**
 * Unknown capacity is a mark, never a bar: no meter, no track, no segment,
 * no tick, and nothing laid out at zero width.
 */
export const Unknown = meta.story({
  args: { capacity: undefined, unknownReason: "statfs unavailable" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Capacity not measured · statfs unavailable")).toBeVisible();
    await expect(canvas.queryByRole("meter")).toBeNull();
    await expect(canvasElement.querySelector("[data-segment], [data-tick], [data-capacity-gauge]")).toBeNull();
    const zeroWidth = [...canvasElement.querySelectorAll("*")].filter((el) => !(el instanceof SVGElement) && el.getBoundingClientRect().width === 0);
    await expect(zeroWidth.map((el) => el.outerHTML.slice(0, 60))).toEqual([]);
  },
});
export const UnknownDesktop = Unknown.extend(desktop);

/** Out of date: the gauge keeps its values and the track gets a dashed border. */
export const Stale = meta.story({
  args: { capacity: DATA_LOW, level: "low", stale: true },
  play: async ({ canvasElement }) => {
    const track = canvasElement.querySelector<HTMLElement>('[role="meter"]')!;
    await expect(getComputedStyle(track).outlineStyle).toBe("dashed");
  },
});
export const StaleDesktop = Stale.extend(desktop);

/**
 * A narrow track (160px, a 320px phone at 200% zoom): 10% and 5% are 8px
 * apart, still two marks, and the caption wraps rather than overflowing.
 */
export const NarrowTrack = meta.story({
  args: { capacity: DATA_LOW, level: "low" },
  parameters: { stageWidth: 160 },
  play: async ({ canvasElement }) => {
    const { track, at } = measure(canvasElement);
    await expect(track.querySelector('[data-tick="both"]')).toBeNull();
    const gap = (at(track.querySelector('[data-tick="very-low"]')!) - at(track.querySelector('[data-tick="low"]')!)) * 160;
    await expect(gap).toBeCloseTo(8, 0);
    await expect(overflowing(canvasElement.firstElementChild as HTMLElement)).toEqual([]);
    await expect(track).toHaveAccessibleDescription("Low below 16.1 GB (10%), very low below 8.05 GB (5%)");
  },
});

/** Below a 4px gap the two ticks merge into one marker; the caption still names both. */
export const CollapsedTicks = meta.story({
  args: { capacity: DATA_LOW, level: "low" },
  parameters: { stageWidth: 72 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-tick="both"]')).toBeTruthy();
    await expect(canvasElement.querySelector('[data-tick="low"]')).toBeNull();
  },
});

/** The four measured states in greyscale: segments read by pattern and the ticks by shape. */
export const Greyscale = meta.story({
  render: (args) => (
    <div style={{ filter: "grayscale(1)", display: "flex", flexDirection: "column", gap: 16, width: "100%" }}>
      <CapacityGauge {...args} capacity={SYSTEM_OK} level="ok" />
      <CapacityGauge {...args} capacity={DATA_LOW} level="low" />
      <CapacityGauge {...args} capacity={DATA_VERY_LOW} level="very-low" />
      <CapacityGauge {...args} capacity={DATA_LOW} level="low" stale />
      <CapacityGauge {...args} capacity={undefined} unknownReason="statfs unavailable" />
    </div>
  ),
});
