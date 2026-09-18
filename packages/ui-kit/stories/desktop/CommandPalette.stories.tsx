import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { documentCount } from "../../fixtures/files.js";
import { CommandPalette, type PaletteGroup } from "../../src/desktop/CommandPalette.js";
import { overflowing, stage } from "../_stage.js";

const GROUPS: PaletteGroup[] = [
  {
    label: "Jump to",
    items: [
      { icon: "file", label: "knowledge/scylla.md", tone: "teal", shortcut: "⏎" },
      { icon: "thread", label: "Route home · thread", tone: "blue" },
    ],
  },
  { label: "Ask", items: [{ icon: "ask", label: "What did I promise Penelope?", tone: "neutral" }] },
  {
    label: "Run",
    items: [
      { icon: "edit", label: "Fix the crew count in day-1043-strait", tone: "amber", effect: "enqueue" },
      { icon: "retry", label: "Re-index knowledge/", tone: "neutral", effect: "reindex" },
    ],
  },
];

const wired = (): PaletteGroup[] =>
  GROUPS.map((g) => ({ ...g, items: g.items.map((it) => ({ ...it, onClick: fn() })) }));

const meta = preview.meta({
  title: "Desktop/CommandPalette",
  component: CommandPalette,
  decorators: [stage],
  parameters: { stageWidth: 520 },
  args: {
    query: "scylla",
    groups: wired(),
    selected: 0,
    footMeta: `${documentCount.toLocaleString("en-US")} docs · 0.2s`,
    onSelect: fn(),
    onClose: fn(),
  },
  argTypes: { selected: { control: { type: "range", min: 0, max: 4, step: 1 } } },
});

/**
 * The desktop's real navigation, behind ⌘K. Results are grouped by WHAT THEY
 * ARE — go somewhere, ask something, run something — rather than ranked into
 * one list, because "jump to a file" and "spend money on my behalf" are not
 * comparable results.
 */
export const Default = meta.story({});

/** The selection on a row that WRITES. Its effect chip is the thing that makes
 * a palette safe. */
export const WriteSelected = Default.extend({ args: { selected: 3 } });

/** Nothing typed yet: the palette opens on the corpus rather than on a blank. */
export const EmptyQuery = Default.extend({ args: { query: "" } });

/** One group, for a query with one kind of answer. */
export const SingleGroup = Default.extend({ args: { groups: [wired()[0]] } });

/**
 * **The rule this component exists to hold: anything that writes shows its
 * effect chip IN THE ROW**, so a palette can never run something the user did
 * not agree to.
 *
 * It is asserted twice, because there are two ways to lose it. The chip must be
 * on screen, and it must be in the row's ACCESSIBLE NAME — the design's own
 * non-negotiable is "a control that writes exposes its effect chip as part of
 * its accessible name", and a chip that a screen reader never reaches is a
 * warning shown only to people who can see it.
 */
export const EveryWriteShowsItsEffect = meta.story({
  play: async ({ canvas }) => {
    const options = await canvas.findAllByRole("option");
    const writes = GROUPS.flatMap((g) => g.items).filter((it) => it.effect);
    await expect(writes).toHaveLength(2);

    for (const write of writes) {
      // In the row, visibly.
      await expect(await canvas.findByText(write.effect!)).toBeTruthy();
      // And in the name a screen reader is given.
      const row = options.find((o) => o.textContent?.includes(write.label))!;
      await expect(row).toHaveAccessibleName(`${write.label}, ${write.effect}`);
    }

    // And the rows that do NOT write carry no chip and no effect in their name.
    for (const jump of GROUPS.flatMap((g) => g.items).filter((it) => !it.effect)) {
      const row = options.find((o) => o.textContent?.includes(jump.label))!;
      await expect(row.textContent).toBe(jump.label + (row === options[0] ? "⏎" : ""));
    }
  },
});

/** A write is set in mono, because what it will do is a command rather than a
 * phrase. Never colour alone, and never chip alone either. */
export const WritesAreMono = meta.story({
  play: async ({ canvas }) => {
    const write = await canvas.findByText("Re-index knowledge/");
    const jump = await canvas.findByText("knowledge/scylla.md");
    await expect(getComputedStyle(write).fontFamily).toContain("JetBrains Mono");
    await expect(getComputedStyle(jump).fontFamily).toContain("Plus Jakarta Sans");
  },
});

/** A dialog with options inside a listbox. `role="option"` outside a listbox
 * announces neither the set nor the position in it, and the list element is
 * this component's own — so it renders the container, as `FilterRow` does. */
export const Roles = meta.story({
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
    const list = await canvas.findByRole("listbox");
    await expect(list.querySelectorAll('[role="option"]')).toHaveLength(5);
    // Each group announces what kind of result it holds.
    const groups = await canvas.findAllByRole("group");
    await expect(groups).toHaveLength(3);
    await expect(groups[2]).toHaveAccessibleName("Run");
  },
});

/**
 * ↑↓ moves, and SELECTION follows focus while ACTIVATION does not — the
 * opposite half of `FilterRow`'s choice, for the opposite reason: arrowing
 * through filters is filtering, and arrowing through a palette must never run
 * anything.
 */
export const ArrowKeysMoveSelection = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const options = await canvas.findAllByRole("option");
    options[0].focus();

    await userEvent.keyboard("{ArrowDown}");
    await expect(args.onSelect).toHaveBeenCalledWith(1);
    await expect(document.activeElement).toBe(options[1]);
    await expect(args.groups?.[0].items[1].onClick).not.toHaveBeenCalled();

    // Wraps at both ends, like every other arrow-key list in the kit.
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    await expect(args.onSelect).toHaveBeenCalledWith(options.length - 1);
    // Home / End move the selection to the edges, still without running.
    await userEvent.keyboard("{Home}");
    await expect(document.activeElement).toBe(options[0]);
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(options[options.length - 1]);
    await expect(args.groups?.[0].items[0].onClick).not.toHaveBeenCalled();
  },
});

/** ⏎ runs the selected row. A click does the same. */
export const EnterRuns = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const options = await canvas.findAllByRole("option");
    options[0].focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.groups?.[0].items[0].onClick).toHaveBeenCalled();
  },
});

/** esc closes, from anywhere inside the dialog. */
export const EscapeCloses = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const options = await canvas.findAllByRole("option");
    options[0].focus();
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).toHaveBeenCalled();
  },
});

/** The tab stop is the selected row and nothing else, so tabbing into the
 * palette lands where the eye already is. */
export const RovingTabStop = meta.story({
  args: { selected: 2 },
  play: async ({ canvas }) => {
    const options = await canvas.findAllByRole("option");
    await expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    await expect(options[2].tabIndex).toBe(0);
  },
});

/** A long label ellipsises rather than widening the palette. */
export const LongLabelsClip = meta.story({
  args: {
    groups: [
      {
        label: "Run",
        items: [
          {
            icon: "edit",
            label: "Fix the crew count in voyage/day-1043-strait-of-scylla-and-charybdis.md",
            tone: "amber",
            effect: "enqueue",
            onClick: fn(),
          },
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>('[role="dialog"]')!;
    await expect(overflowing(box)).toEqual([]);
  },
});

/**
 * THE CONTRACT. A palette whose rows carry no callbacks is the picture the
 * design draws: no listbox, no options, no tab stops. The dialog role stays,
 * because that is what the surface IS rather than an interactive treatment —
 * and so do both effect chips, because the chip is the safety rule and not a
 * hover state.
 */
export const Static = meta.story({
  args: { groups: GROUPS, onSelect: undefined, onClose: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole("dialog")).toBeTruthy();
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await expect(canvas.queryByRole("option")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(await canvas.findByText("enqueue")).toBeTruthy();
    await expect(await canvas.findByText("reindex")).toBeTruthy();
  },
});
