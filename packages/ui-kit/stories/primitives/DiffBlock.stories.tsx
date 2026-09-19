import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { DiffBlock } from "../../src/primitives/DiffBlock.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Primitives/DiffBlock",
  component: DiffBlock,
  decorators: [stage],
  args: { text: "- crew: 12\n+ crew: 6", variant: "boxed", tinted: false, fontSize: 10.5, pad: 10 },
  argTypes: {
    variant: { control: "select", options: ["inset", "boxed"] },
    tinted: { control: "boolean" },
    fontSize: { control: { type: "number", min: 9, max: 12, step: 0.5 } },
    pad: { control: { type: "number", min: 6, max: 16, step: 1 } },
  },
});

/** Monochrome on purpose: the +/- markers carry the meaning, and colour is
 * reserved for whether a human still has to decide something. */
export const Default = meta.story({});

/** `inset` drops the border and darkens, for a diff living inside another card. */
export const Inset = Default.extend({
  args: {
    variant: "inset",
    text: "  route: strait of messina\n- pass: charybdis\n+ pass: scylla\n  note: six lost, ship kept",
  },
});

/** Long lines wrap rather than scroll (`white-space: pre-wrap`), so a diff
 * never forces its container wider. */
export const LongLines = Default.extend({
  parameters: { stageWidth: 200 },
  args: {
    text: "- warning: the sirens sing to whoever hears them, and no one who hears them returns\n+ warning: stop the crew's ears with wax; tie me to the mast",
  },
});

export const Wide = Default.extend({ parameters: wide });

/**
 * TINTED is for the one case where the diff IS the decision — a tool receipt
 * whose approval turns on these exact lines (seventh drop, ruling 5). Removed
 * rows on a red ground, added rows on teal, at the tint rule on the fill hue;
 * the sign column is the mark, so it takes the tone's ink at full weight —
 * never 70% alpha. Context rows stay ink-mute with an empty sign cell.
 *
 * A diff row is the record, so the long line WRAPS with a hanging indent: the
 * sign column is a fixed 8px flex item and the text is its own box, so a
 * wrapped continuation lines up under the text and can never be misread as
 * an unsigned line. Nothing truncates and nothing scrolls sideways.
 */
export const Tinted = Default.extend({
  parameters: { stageWidth: 240 },
  args: {
    tinted: true,
    text: [
      "  route: strait of messina",
      "- crew: 12",
      "+ crew: 6",
      "  note: six lost to the rock, the ship kept, the mast held, and the rest rowed on until the whirlpool was behind them",
      "- status: under way",
      "+ status: hold",
    ].join("\n"),
  },
  play: async ({ canvasElement }) => {
    const block = canvasElement.querySelector<HTMLElement>("[data-tinted]")!;
    await expect(block).not.toBeNull();
    const rows = [...block.querySelectorAll<HTMLElement>("[data-sign]")];
    await expect(rows.map((r) => r.dataset.sign)).toEqual([" ", "-", "+", " ", "-", "+"]);
    // No row escapes the block: the long context line wrapped.
    await expect(overflowing(block)).toEqual([]);
    await expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth + 1);
    const long = rows[3]!;
    await expect(long.getBoundingClientRect().height).toBeGreaterThan(rows[0]!.getBoundingClientRect().height * 1.5);
    // The sign column is the same 8px on every row, so the text column starts
    // at one x whether the row wrapped or not — the hanging indent.
    for (const row of rows) {
      const [sign, text] = [...row.children] as HTMLElement[];
      await expect(Math.round(sign!.getBoundingClientRect().width)).toBe(8);
      await expect(Math.round(text!.getBoundingClientRect().left)).toBe(
        Math.round(rows[0]!.children[1]!.getBoundingClientRect().left),
      );
    }
    // The sign is the mark: full weight, the tone's ink, no alpha.
    const minus = rows[1]!.children[0] as HTMLElement;
    const plus = rows[2]!.children[0] as HTMLElement;
    await expect(getComputedStyle(minus).fontWeight).toBe("600");
    await expect(getComputedStyle(minus).color).not.toMatch(/rgba/);
    await expect(getComputedStyle(plus).color).not.toBe(getComputedStyle(minus).color);
    // Grounds on the changed rows only.
    await expect(getComputedStyle(rows[0]!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    await expect(getComputedStyle(rows[1]!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  },
});
