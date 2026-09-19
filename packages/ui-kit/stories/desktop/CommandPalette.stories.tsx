import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { documentCount } from "../../fixtures/files.js";
import { CommandPalette, type PaletteGroup } from "../../src/desktop/CommandPalette.js";
import { overflowing, ROW_RING, ring, stage } from "../_stage.js";

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

/** The design's own default, in the Odyssey's words: a spend, a write, and
 * three rows the host cannot serve right now. Every row wired, including the
 * disabled ones, so that the contract "a disabled row never runs" has
 * something to assert against. */
const HOST_DOWN: PaletteGroup[] = [
  {
    label: "Jump to",
    items: [
      { icon: "thread", label: "New chat", tone: "amber", shortcut: "⌘N" },
      { icon: "file", label: "knowledge/scylla.md", tone: "teal" },
      { icon: "history", label: "Sessions", tone: "neutral" },
      { icon: "graph", label: "The graph around Ithaca", tone: "purple", shortcut: "⌘4" },
    ],
  },
  {
    label: "Ask",
    items: [
      { icon: "ask", label: "What did I promise Penelope?", tone: "neutral" },
      { icon: "search", label: "Search the brain for “crew count”", tone: "neutral" },
      { icon: "activity", label: "Brain statistics", tone: "neutral", why: "needs the host" },
    ],
  },
  {
    label: "Run",
    items: [
      { icon: "retry", label: "Sync the brain", tone: "amber", effect: "sync", why: "needs the host" },
      { icon: "digest", label: "Daily briefing", tone: "gold", cost: "~$0.12", why: "needs the host" },
      { icon: "edit", label: "Add a note", tone: "neutral" },
    ],
  },
];

const hostDown = (): PaletteGroup[] =>
  HOST_DOWN.map((g) => ({ ...g, items: g.items.map((it) => ({ ...it, onClick: fn() })) }));

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
    onQueryChange: fn(),
    onSelect: fn(),
    onClose: fn(),
  },
  argTypes: { selected: { control: { type: "range", min: 0, max: 9, step: 1 } } },
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
  args: { groups: GROUPS, onQueryChange: undefined, onSelect: undefined, onClose: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole("dialog")).toBeTruthy();
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await expect(canvas.queryByRole("option")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(await canvas.findByText("enqueue")).toBeTruthy();
    await expect(await canvas.findByText("reindex")).toBeTruthy();
    // The query is still a real input — read-only rather than fake, as the
    // composer's is — so it still focuses and still announces itself.
    const input = await canvas.findByRole<HTMLInputElement>("combobox");
    await expect(input.readOnly).toBe(true);
  },
});

/**
 * The query is a real `<input role="combobox">` that owns the listbox. A
 * drawn caret over overlay keystroke capture loses IME, autocorrect, selection
 * and paste; a real input keeps them, and `onQueryChange` is what makes it
 * editable. It is CONTROLLED: what is typed goes to the app and comes back as
 * `query`, so with a mock handler the field reads what the args say.
 */
export const TypedQuery = meta.story({
  args: { query: "" },
  play: async ({ canvas, userEvent, args }) => {
    const input = await canvas.findByRole<HTMLInputElement>("combobox", {
      name: "Search places, questions and commands",
    });
    await expect(input.tagName).toBe("INPUT");
    await expect(input.readOnly).toBe(false);
    await expect(input).toHaveAttribute("aria-expanded", "true");
    const list = await canvas.findByRole("listbox");
    await expect(input.getAttribute("aria-controls")).toBe(list.id);
    await expect(input).toHaveAttribute("placeholder", "Where to, what to ask, what to run…");

    await userEvent.click(input);
    await userEvent.keyboard("s");
    await expect(args.onQueryChange).toHaveBeenCalledWith("s");
    // Typing into the field runs nothing and moves nothing.
    await expect(args.onSelect).not.toHaveBeenCalled();
    await expect(args.groups?.[0].items[0].onClick).not.toHaveBeenCalled();
    // esc still closes from inside the field.
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).toHaveBeenCalled();
  },
});

/** The focus ring is on the ROW around the input, drawn inside, because the
 * row is the top strip of a dialog that clips. */
export const QueryRing = meta.story({
  play: async ({ canvas, userEvent }) => {
    const input = await canvas.findByRole("combobox");
    await userEvent.tab();
    await expect(document.activeElement).toBe(input);
    await expect(ring(input.closest(".bk-field")!)).toEqual(ROW_RING);
    await expect(ring(input).style).toBe("none");
  },
});

/**
 * A command the host cannot currently serve is shown DISABLED with the reason,
 * never omitted: dropping rows while the socket is down teaches that the
 * palette's contents are a guess. `why` is the whole rule — the reason is
 * printed and announced, the row has no tab stop and no click, and ↑↓ step
 * over it as if it were not there while its flat index still counts.
 */
export const DisabledRowsAreSkipped = meta.story({
  args: { groups: hostDown(), query: "" },
  play: async ({ canvas, userEvent, args }) => {
    const options = await canvas.findAllByRole("option");
    await expect(options).toHaveLength(10);
    const off = options.filter((o) => o.getAttribute("aria-disabled") === "true");
    await expect(off).toHaveLength(3);
    for (const row of off) {
      await expect(row).toHaveAttribute("aria-selected", "false");
      await expect(row.hasAttribute("tabindex")).toBe(false);
      await expect(row.classList.contains("bk-row")).toBe(false);
      await expect(getComputedStyle(row).opacity).toBe("0.45");
      await expect(row).toHaveAccessibleName(/, needs the host$/);
      await expect(row.textContent).toContain("needs the host");
    }
    // A click on a disabled row runs nothing.
    await userEvent.click(off[0]);
    await expect(args.groups?.[1].items[2].onClick).not.toHaveBeenCalled();

    // From "Search the brain" (5), ↓ skips "Brain statistics" (6), "Sync" (7)
    // and "Daily briefing" (8) and lands on "Add a note" (9).
    options[5].focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(args.onSelect).toHaveBeenLastCalledWith(9);
    await expect(document.activeElement).toBe(options[9]);
    // And ↑ from there steps back over the same three.
    await userEvent.keyboard("{ArrowUp}");
    await expect(args.onSelect).toHaveBeenLastCalledWith(5);
    await expect(document.activeElement).toBe(options[5]);
    // End lands on the last ENABLED row, not the last row.
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(options[9]);
  },
});

/** A `selected` that lands on a disabled row falls through to the next
 * enabled one, so the roving tab stop always has somewhere to sit. */
export const SelectionFallsThroughDisabled = meta.story({
  args: { groups: hostDown(), query: "", selected: 7 },
  play: async ({ canvas }) => {
    const options = await canvas.findAllByRole("option");
    await expect(options[7]).toHaveAttribute("aria-selected", "false");
    await expect(options[9]).toHaveAttribute("aria-selected", "true");
    await expect(options.filter((o) => o.tabIndex === 0)).toEqual([options[9]]);
  },
});

/**
 * Anything that SPENDS shows a cost chip — gold, mono, `~$` — because spending
 * money is an effect even when nothing is written. It rides in the accessible
 * name the way the effect chip does, and a spend is set in mono like a write.
 */
export const CostChip = meta.story({
  args: {
    query: "",
    groups: [
      {
        label: "Run",
        items: [
          { icon: "digest", label: "Daily briefing", tone: "gold", cost: "~$0.12", onClick: fn() },
          { icon: "edit", label: "Add a note", tone: "neutral", onClick: fn() },
        ],
      },
    ],
  },
  play: async ({ canvas }) => {
    const chip = await canvas.findByText("~$0.12");
    await expect(getComputedStyle(chip).fontFamily).toContain("JetBrains Mono");
    const [briefing, note] = await canvas.findAllByRole("option");
    await expect(briefing).toHaveAccessibleName("Daily briefing, ~$0.12");
    await expect(getComputedStyle(await canvas.findByText("Daily briefing")).fontFamily).toContain("JetBrains Mono");
    // Opening a form is not an effect: the bare row carries no chip.
    await expect(note.textContent).toBe("Add a note");
  },
});

/** The list scrolls past `maxHeight` rather than clipping, so a row is never
 * both cut and unreachable. Ten rows at 180px is a scroll, and End reaches
 * the bottom of it. */
export const Scrolls = meta.story({
  args: { groups: hostDown(), query: "", maxHeight: 180 },
  play: async ({ canvas, userEvent }) => {
    const list = await canvas.findByRole("listbox");
    await expect(getComputedStyle(list).overflowY).toBe("auto");
    await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    const options = await canvas.findAllByRole("option");
    options[0].focus();
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(options[9]);
    await expect(list.scrollTop).toBeGreaterThan(0);
  },
});

/**
 * The design's default: what the palette shows with no `groups` at all, and
 * so with no handlers on any row. That makes it the picture rather than a
 * listbox, and a picture that scrolls has no keyboard path into it, which axe
 * rightly refuses; the ten fallback rows are taller than the default 320, so
 * this story gives them the room. An app never renders this: its rows carry
 * `onClick`, and a listbox of options scrolls with its focus.
 */
export const Fallback = meta.story({
  args: { groups: undefined, query: "scylla", selected: 1, maxHeight: 440 },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("↑↓ move · ⏎ run · home/end ends · esc closes")).toBeTruthy();
    await expect(await canvas.findByText("⌘N")).toBeTruthy();
    await expect(await canvas.findByText("sync")).toBeTruthy();
    await expect(await canvas.findByText("~$0.12")).toBeTruthy();
    await expect(await canvas.findAllByText("needs the host")).toHaveLength(3);
  },
});
