import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { weekSpendMeter } from "../../fixtures/money.js";
import { queueItems } from "../../fixtures/actions.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { SideRail, type RailItem } from "../../src/desktop/SideRail.js";
import { overflowing, stage } from "../_stage.js";

const ITEMS: RailItem[] = [
  { icon: "brain", label: "Chat", shortcut: "1" },
  { icon: "resolved", label: "Actions", badge: "6", shortcut: "2" },
  { icon: "activity", label: "Activity", shortcut: "3" },
  { icon: "files", label: "Files", shortcut: "4" },
  { icon: "settings", label: "Settings", shortcut: "5" },
];

const wired = () => ITEMS.map((it) => ({ ...it, onClick: fn() }));

const meta = preview.meta({
  title: "Desktop/SideRail",
  component: SideRail,
  decorators: [stage],
  parameters: { stageWidth: "none" },
  args: {
    items: wired(),
    active: 1,
    expanded: true,
    status: "connected",
    spendPct: weekSpendMeter.value,
    spendText: weekSpendMeter.valueText,
  },
  argTypes: { active: { control: { type: "range", min: 0, max: 4, step: 1 } } },
  render: (args) => (
    <div style={{ display: "flex", height: 420, width: "100%" }}>
      <SideRail {...args} />
    </div>
  ),
});

/**
 * The `TabBar` unrolled. Same five destinations, same amber-means-here rule.
 * What a rail can afford that a tab bar cannot is a shortcut per destination and
 * the day's spend, both always visible rather than behind a tap.
 */
export const Expanded = meta.story({});

/**
 * 60px, for 480-899px windows (D22). Collapsing hides everything whose value is
 * a word — the labels, the shortcut keys, the spend meter — and keeps the icons,
 * the badge and ⌘K. Each row keeps its name through `aria-label`, so the rail
 * stays navigable by voice and by screen reader when it stops being readable by
 * eye.
 */
export const Collapsed = Expanded.extend({ args: { expanded: false } });

export const ChatActive = Expanded.extend({ args: { active: 0 } });

/** A wider rail, up to the design's own 280px ceiling. */
export const WideRail = Expanded.extend({ args: { width: 260 } });

/** D22's breakpoint ladder needs both widths to be exactly what it says. */
export const WidthsAreTheLadder = meta.story({
  play: async ({ canvasElement }) => {
    const rail = canvasElement.querySelector<HTMLElement>('[style*="border-right"]')!;
    await expect(rail.getBoundingClientRect().width).toBe(208);
  },
});

export const CollapsedWidth = Collapsed.extend({
  play: async ({ canvasElement }) => {
    const rail = canvasElement.querySelector<HTMLElement>('[style*="border-right"]')!;
    await expect(rail.getBoundingClientRect().width).toBe(60);
  },
});

/**
 * **The wave-5 hazard, checked in the shape that causes it.**
 *
 * Since wave 1 dropped the `sc-host` wrapper, `width: 100%` on a component root
 * is live, and two such roots in one flex row each claim the whole row — which
 * is exactly how `ApprovalCard` shipped with a button outside the card. A rail
 * beside a screen is that shape, and this is the first component in the kit
 * that deliberately sits in it.
 *
 * The rail is safe because it declares `flex: none` and an explicit width
 * rather than `width: 100%`. That is a property to verify, not to assume, so
 * this renders a real two-pane layout and measures it.
 */
export const TwoPaneDoesNotOverflow = meta.story({
  render: (args) => (
    <div id="pane" style={{ display: "flex", height: 420, width: 900, overflow: "hidden" }}>
      <SideRail {...args} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <ScreenHeader title="Actions" meta="6 waiting" metaTone="teal" />
        <ScreenBody overflow="auto">
          {queueItems.slice(0, 4).map((item, i) => (
            <QueueItemRow key={`${item.subject}-${i}`} state={item.state} subject={item.subject} meta={item.meta} />
          ))}
        </ScreenBody>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pane = canvasElement.querySelector<HTMLElement>("#pane")!;
    await expect(overflowing(pane)).toEqual([]);

    // The rail takes its 208 and the screen takes the remaining 692 — neither
    // claims the whole row.
    const [rail, screen] = [...pane.children] as HTMLElement[];
    await expect(rail.getBoundingClientRect().width).toBe(208);
    await expect(Math.round(screen.getBoundingClientRect().width)).toBe(692);
  },
});

/** A tap navigates, and so does Enter. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tabs[3]);
    await expect(args.items?.[3].onClick).toHaveBeenCalled();
  },
});

/**
 * ↑↓ rather than ←→, because the rail is vertical and says so with
 * `aria-orientation`. Activation does not follow focus: arrowing through
 * destinations would navigate away from the screen you are on.
 */
export const ArrowKeys = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const list = await canvas.findByRole("tablist");
    await expect(list).toHaveAttribute("aria-orientation", "vertical");

    const tabs = await canvas.findAllByRole("tab");
    tabs[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(tabs[1]);
    await expect(args.items?.[1].onClick).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    await expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    // Home / End land on the edges without activating either.
    await userEvent.keyboard("{Home}");
    await expect(document.activeElement).toBe(tabs[0]);
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    await expect(args.items?.[0].onClick).not.toHaveBeenCalled();
  },
});

/** Collapsed, a row is an icon — so its accessible name has to come from
 * somewhere, and it comes from `aria-label`. */
export const CollapsedRowsKeepTheirNames = Collapsed.extend({
  play: async ({ canvas }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs[1]).toHaveAccessibleName("Actions");
  },
});

/** A rail row fills its container, so `.bk-row` — ring inside at -2 — plus
 * `.bk-row-fg`, because its hover moves the foreground as well. */
export const RowClasses = meta.story({
  play: async ({ canvas }) => {
    const tabs = await canvas.findAllByRole("tab");
    for (const tab of tabs) {
      await expect(tab.className).toBe("bk-row bk-row-fg");
      await expect(tab.style.getPropertyValue("--hv-bg")).not.toBe("");
      await expect(tab.style.getPropertyValue("--hv-fg")).not.toBe("");
    }
  },
});

/** THE CONTRACT. A rail with no callbacks has no tablist, no roles and no tab
 * stops — the wordmark, the badge and the spend meter still render, because a
 * rail that cannot be clicked is still a status display. */
export const Static = meta.story({
  args: { items: ITEMS },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("tablist")).toBeNull();
    await expect(canvas.queryByRole("tab")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(await canvas.findByText("6")).toBeTruthy();
  },
});

/**
 * ONE TAB STOP, NOT FIVE — the vertical half of §11.
 *
 * The rail and the `TabBar` used to cost five tab presses each, which is where
 * the ten in `Rules/Keyboard reachability` came from. Tab reaches the rail once
 * and lands on the active destination; ↑↓ move inside it; Tab leaves. The
 * wordmark, the spend meter and the ⌘K cap are not controls and were never
 * stops, so the whole rail is one.
 */
export const OneTabStop = meta.story({
  play: async ({ canvas, canvasElement, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs).toHaveLength(5);
    await expect(canvasElement.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await expect(tabs[1]).toHaveAttribute("tabindex", "0");

    await userEvent.tab();
    await expect(document.activeElement).toBe(tabs[1]);
    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(false);
  },
});

/** The stop follows the caret, so leaving the rail and coming back returns you
 * to the destination you had arrowed to rather than to the active one. */
export const TheStopFollowsTheCaret = meta.story({
  play: async ({ canvas, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    tabs[1].focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(document.activeElement).toBe(tabs[3]);
    await expect(tabs[3]).toHaveAttribute("tabindex", "0");
    await expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  },
});

/** The hazard: the amber destination carries no callback, so the stop falls to
 * the first one that does rather than leaving the rail unreachable. */
export const AnUnreachableActiveRowDoesNotStrandTheRail = meta.story({
  args: { items: [ITEMS[0], { ...ITEMS[1] }, { ...ITEMS[2], onClick: fn() }], active: 1 },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    await expect(tabs).toHaveLength(1);
    await expect(tabs[0]).toHaveAttribute("tabindex", "0");
    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(true);
  },
});
