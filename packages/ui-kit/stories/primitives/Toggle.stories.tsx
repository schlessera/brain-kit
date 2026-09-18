import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { Toggle } from "../../src/primitives/Toggle.js";
import type { ToggleTone } from "../../src/types.js";
import { Row, stage } from "../_stage.js";

const TONES: ToggleTone[] = ["amber", "teal", "purple"];

const meta = preview.meta({
  title: "Primitives/Toggle",
  component: Toggle,
  decorators: [stage],
  // `label` is what an operable switch is CALLED, and it is not optional in
  // practice: a switch is pure geometry, so there is no visible text for a
  // screen reader to fall back on and axe fails it (`aria-toggle-field-name`).
  // Wave 1b added the prop; the design draws no label of any kind.
  args: { on: true, tone: "amber", label: "Watch this folder", onClick: fn() },
  argTypes: { tone: { control: "select", options: TONES } },
});

/** `on` falls back to true (`p.on !== false`), so an unset Toggle reads as on. */
export const Default = meta.story({});

export const Off = Default.extend({ args: { on: false } });

/**
 * The design's fourth state, which the switch did not have until the app
 * needed it (a push subscription mid-creation): dimmed, inert, out of the tab
 * order, still named and still a switch — so a screen reader learns it exists
 * and cannot be flipped, rather than finding it gone.
 */
export const Disabled = Default.extend({
  args: { disabled: true },
  play: async ({ canvas, args }) => {
    const toggle = await canvas.findByRole("switch", { name: "Watch this folder" });
    await expect(toggle.getAttribute("aria-disabled")).toBe("true");
    await expect(toggle.getAttribute("tabindex")).toBe("-1");
    await expect(getComputedStyle(toggle).opacity).toBe("0.45");
    await expect(getComputedStyle(toggle).pointerEvents).toBe("none");
    // pointer-events:none stops a real pointer; a synthetic click must fail too.
    toggle.click();
    await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const Tones = meta.story({
  render: () => (
    <>
      {TONES.map((tone) => (
        <Row key={tone} caption={tone}>
          <Toggle tone={tone} on />
          <Toggle tone={tone} on={false} />
        </Row>
      ))}
    </>
  ),
});

/**
 * The tap reaches the callback, and so does the space bar. `role="switch"`,
 * `aria-checked` and the tab stop appear only because a handler was passed.
 */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    // Found BY ITS NAME, which is the assertion: an unnamed switch is reachable
    // by role but unidentifiable to anyone who cannot see it.
    const track = await canvas.findByRole("switch", { name: "Watch this folder" });
    await expect(track).toHaveAttribute("aria-checked", "true");
    await userEvent.click(track);
    await expect(args.onClick).toHaveBeenCalled();

    track.focus();
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
});

/**
 * `labelledBy` points at visible text instead, for a switch that sits beside its
 * own label in a row. It wins over `label` when both are given: a name the user
 * can read beats one only the screen reader hears.
 */
export const LabelledByVisibleText = meta.story({
  args: { label: "ignored when labelledBy is set", labelledBy: "watch-label" },
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span id="watch-label" style={{ font: "400 13px/1 system-ui, sans-serif", color: "var(--bk-color-ink)" }}>
        Watch this folder
      </span>
      <Toggle {...args} />
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("switch", { name: "Watch this folder" })).toBeVisible();
  },
});

/**
 * A Toggle with no handler is inert: no role, no tab stop, no name — and, the
 * part that matters beyond itself, no expanded hit area to steal a neighbour's
 * click.
 */
export const Decorative = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("switch")).toBeNull();
    const track = canvasElement.querySelector("span")!;
    await expect(track.className).toBe("");
    await expect(track.getAttribute("tabindex")).toBeNull();
    // A decorative switch names nothing, because it IS nothing to announce.
    await expect(track.getAttribute("aria-label")).toBeNull();
  },
});

/**
 * THE HIT-TARGET TEST.
 *
 * The switch is drawn 38x22 and must be hittable at 44x44, which it reaches
 * with a transparent pseudo-element at -11px top and bottom, -3px left and
 * right. The design's constraint on that expansion: **per side it must be no
 * more than half the distance to the nearest interactive neighbour.** 11px up
 * and down therefore needs at least 22px of vertical gap.
 *
 * Get it wrong and a neighbour's invisible pseudo-element sits on top of your
 * visual and takes the click, because the later sibling wins the hit test. The
 * design records this happening for real: FeedbackRow briefly recorded
 * thumbs-down for a thumbs-up.
 *
 * The test probes `elementFromPoint` at each switch's EDGES, not its centre,
 * because a centre always passes — it is the edges that overlap. Both switches
 * below sit in a 24px-gap column, which clears the 22px minimum by 2px.
 */
export const HitTargets = meta.story({
  render: (args) => (
    // The padding is not decoration: a 44px target around a 38x22 visual reaches
    // 11px past the paint, so without it the first switch's target starts off
    // the top of the viewport and elementFromPoint returns null rather than the
    // switch. That is a real property of expanded targets near a container edge.
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: 20 }}>
      <Toggle {...args} />
      <Toggle {...args} on={false} />
    </div>
  ),
  play: async ({ canvas }) => {
    const [first, second] = await canvas.findAllByRole("switch");

    for (const [name, el] of [
      ["first", first],
      ["second", second],
    ] as const) {
      const box = el.getBoundingClientRect();
      // 38x22 drawn; -3/-11 expansion; 1px inside each edge of the 44x44 target
      // so the probe lands on the hit area rather than exactly on its boundary.
      const left = box.left - 3 + 1;
      const right = box.right + 3 - 1;
      const top = box.top - 11 + 1;
      const bottom = box.bottom + 11 - 1;

      const corners: [string, number, number][] = [
        ["top-left", left, top],
        ["top-right", right, top],
        ["bottom-left", left, bottom],
        ["bottom-right", right, bottom],
        ["top-centre", (left + right) / 2, top],
        ["bottom-centre", (left + right) / 2, bottom],
      ];

      for (const [corner, x, y] of corners) {
        const hit = document.elementFromPoint(x, y);
        // The switch itself, or the knob inside it. Anything else means a
        // neighbour's invisible target is sitting on this one.
        const owner = hit?.closest('[role="switch"]');
        await expect(`${name} ${corner} -> ${owner === el ? "self" : "STOLEN"}`).toBe(
          `${name} ${corner} -> self`,
        );
      }
    }

    // And the target really is 44 tall: a point 12px above the paint belongs to
    // nothing, so the expansion stops where the design says it stops.
    const box = first.getBoundingClientRect();
    const outside = document.elementFromPoint(box.left + box.width / 2, box.top - 12);
    await expect(outside?.closest('[role="switch"]')).toBeNull();
  },
});
