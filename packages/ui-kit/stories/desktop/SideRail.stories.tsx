import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { weekSpendMeter } from "../../fixtures/money.js";
import { queueItems } from "../../fixtures/actions.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { SideRail, type RailAct, type RailItem } from "../../src/desktop/SideRail.js";
import { overflowing, stage } from "../_stage.js";

const ITEMS: RailItem[] = [
  { icon: "brain", label: "Chat", shortcut: "1" },
  { icon: "resolved", label: "Actions", badge: "6", shortcut: "2" },
  { icon: "files", label: "Files", shortcut: "3" },
  { icon: "graph", label: "Graph", shortcut: "4" },
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

/**
 * An app that tracks no spend and has no palette passes `null` for each, and
 * the footer draws neither — `undefined` keeps the fixture defaults the other
 * stories render. A printed ⌘K that opens nothing would break the design's
 * "every shortcut is printed where it applies", so the cap goes with the
 * hint. The status line takes a tone for a rail that has to say the
 * connection is gone.
 */
export const NoSpendNoPalette = Expanded.extend({
  args: { spendPct: null, hint: null, status: "offline", statusTone: "red" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.textContent).not.toContain(weekSpendMeter.valueText);
    await expect(canvasElement.textContent).not.toContain("⌘K");
    await expect(canvasElement.textContent).toContain("offline");
  },
});

/* ── Acts and All commands (D52 §1, #944) ─────────────────────────────────── */

const ACTS: RailAct[] = [
  { icon: "search", label: "Search", name: "Search the brain" },
  { icon: "add", label: "Add a note" },
  { icon: "digest", label: "Daily briefing", cost: "spends" },
];

const wiredActs = (why?: string): RailAct[] =>
  ACTS.map((it) => ({ ...it, onClick: fn(), ...(it.cost && why ? { why } : {}) }));

const NAMES = ["Search the brain", "Add a note", "Daily briefing, spends"];

/**
 * Under the destinations, past a divider: Search, Add a note and the briefing,
 * in that order. The briefing prints `spends` at rest, in the shortcut column,
 * because spending money is an effect even when nothing is written (D38 §5).
 * The ⌘K cap is now the `All commands` button.
 */
export const WithActs = Expanded.extend({
  args: { acts: wiredActs(), onOpenPalette: fn() },
  play: async ({ canvas, args, userEvent }) => {
    const toolbar = await canvas.findByRole("toolbar", { name: "Acts" });
    await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
    const acts = [...toolbar.querySelectorAll("button")];
    await expect(acts.map((b) => b.getAttribute("aria-label"))).toEqual(NAMES);
    await expect(acts[2]).toHaveTextContent("spends");
    // An act is never "here": nothing in the toolbar claims selection.
    for (const act of acts) await expect(act).not.toHaveAttribute("aria-selected");

    const all = await canvas.findByRole("button", { name: "All commands" });
    await expect(all).toHaveAttribute("aria-keyshortcuts", "Meta+K");
    await expect(all).toHaveTextContent("⌘K");
    await userEvent.click(all);
    await expect(args.onOpenPalette).toHaveBeenCalledTimes(1);
    await userEvent.click(acts[1]!);
    await expect(args.acts?.[1]?.onClick).toHaveBeenCalledTimes(1);
    await expect(args.items?.[1]?.onClick).not.toHaveBeenCalled();
  },
});

/**
 * 60px. Search and Add are icons with their names and no tooltip; the
 * briefing is not drawn, because a 44px column cannot print `spends` (V6).
 * All commands reaches it in two activations (D52 §2).
 */
export const CollapsedWithActs = WithActs.extend({
  args: { expanded: false },
  play: async ({ canvas, canvasElement }) => {
    const toolbar = await canvas.findByRole("toolbar", { name: "Acts" });
    const acts = [...toolbar.querySelectorAll("button")];
    await expect(acts.map((b) => b.getAttribute("aria-label"))).toEqual(NAMES.slice(0, 2));
    await expect(canvasElement.textContent).not.toContain("spends");
    await expect(canvasElement.querySelector("[title]")).toBeNull();
    const all = await canvas.findByRole("button", { name: "All commands" });
    await expect(all).toHaveTextContent("⌘K");
  },
});

/**
 * THREE STOPS, NOT NINE. The destinations are one roving stop, the acts are a
 * second, independent one, and All commands is the third. Tab leaves after.
 */
export const ThreeTabStops = WithActs.extend({
  play: async ({ canvas, canvasElement, userEvent }) => {
    const tabs = await canvas.findAllByRole("tab");
    const acts = [...(await canvas.findByRole("toolbar", { name: "Acts" })).querySelectorAll("button")];
    const all = await canvas.findByRole("button", { name: "All commands" });
    await expect(canvasElement.querySelectorAll('[tabindex="0"]')).toHaveLength(2);

    await userEvent.tab();
    await expect(document.activeElement).toBe(tabs[1]);
    await userEvent.tab();
    await expect(document.activeElement).toBe(acts[0]);
    await userEvent.tab();
    await expect(document.activeElement).toBe(all);
    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(false);
  },
});

/**
 * ↑↓ / Home / End walk the acts and wrap inside the toolbar; they never cross
 * the divider into the destinations. Arrows move and do not invoke; ⏎ and
 * space each invoke exactly once.
 */
export const ActArrowsStayInTheToolbar = WithActs.extend({
  play: async ({ canvas, args, userEvent }) => {
    const acts = [...(await canvas.findByRole("toolbar", { name: "Acts" })).querySelectorAll("button")];
    acts[0]!.focus();
    await userEvent.keyboard("{ArrowUp}");
    await expect(document.activeElement).toBe(acts[2]);
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(acts[0]);
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(acts[2]);
    await userEvent.keyboard("{Home}");
    await expect(document.activeElement).toBe(acts[0]);
    await userEvent.keyboard("{ArrowDown}");
    await expect(acts[1]).toHaveAttribute("tabindex", "0");
    for (const it of args.acts ?? []) await expect(it.onClick).not.toHaveBeenCalled();
    for (const it of args.items ?? []) await expect(it.onClick).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    await expect(args.acts?.[1]?.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.acts?.[1]?.onClick).toHaveBeenCalledTimes(2);
  },
});

/**
 * The host is gone. The briefing stays, its name dimmed, with `spends` and the
 * reason printed at rest on a second line, never only on hover. It is still a
 * stop in the toolbar, so the reason can be read, and nothing invokes it.
 */
export const OfflineBriefing = WithActs.extend({
  args: { acts: wiredActs("needs the host"), status: "offline", statusTone: "red" },
  play: async ({ canvas, args, userEvent }) => {
    const briefing = await canvas.findByRole("button", { name: "Daily briefing, spends, unavailable: needs the host" });
    await expect(briefing).toHaveAttribute("aria-disabled", "true");
    await expect(briefing).toHaveTextContent("spends");
    await expect(briefing).toHaveTextContent("needs the host");
    await userEvent.click(briefing);
    briefing.focus();
    await userEvent.keyboard("{Enter} ");
    await expect(args.acts?.[2]?.onClick).not.toHaveBeenCalled();
    await expect(document.activeElement).toBe(briefing);
  },
});

/** A turn is running, so the briefing waits, and says so. */
export const StreamingBriefing = WithActs.extend({
  args: { acts: wiredActs("a turn is running") },
  play: async ({ canvas }) => {
    const briefing = await canvas.findByRole("button", { name: "Daily briefing, spends, unavailable: a turn is running" });
    await expect(briefing).toHaveTextContent("a turn is running");
  },
});

/** Collapsed, an act that would have to carry a reason is not drawn at all. */
export const CollapsedOffline = OfflineBriefing.extend({
  args: { expanded: false },
  play: async ({ canvas, canvasElement }) => {
    const acts = [...(await canvas.findByRole("toolbar", { name: "Acts" })).querySelectorAll("button")];
    await expect(acts).toHaveLength(2);
    await expect(canvasElement.textContent).not.toContain("needs the host");
  },
});

/**
 * A phone-sized tablet in landscape is about 360px tall. The middle — the
 * destinations through the acts — scrolls; the wordmark and All commands stay
 * pinned inside the rail.
 */
export const ShortViewport = WithActs.extend({
  render: (args) => (
    <div style={{ display: "flex", height: 360, width: "100%" }}>
      <SideRail {...args} />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    const rail = canvasElement.querySelector<HTMLElement>(".bk-side-rail")!;
    const middle = rail.querySelector<HTMLElement>(".bk-side-rail-middle")!;
    const all = await canvas.findByRole("button", { name: "All commands" });
    const box = rail.getBoundingClientRect();
    await expect(box.height).toBe(360);
    await expect(middle.scrollHeight).toBeGreaterThan(middle.clientHeight);
    await expect(all.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.bottom);
    await expect(canvas.getByText("Brain").getBoundingClientRect().top).toBeGreaterThanOrEqual(box.top);
  },
});

/** The ring is the kit's inside -2 ring, on an act and on All commands. */
export const FocusShown = WithActs.extend({
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab();
    await userEvent.tab();
    const act = document.activeElement as HTMLElement;
    await expect(act).toHaveAccessibleName("Search the brain");
    await expect(getComputedStyle(act).outlineOffset).toBe("-2px");
    await userEvent.tab();
    const all = await canvas.findByRole("button", { name: "All commands" });
    await expect(document.activeElement).toBe(all);
    await expect(getComputedStyle(all).outlineOffset).toBe("-2px");
  },
});

/** Long labels wrap inside the 208px column; nothing leaves the rail. */
export const LongActLabels = WithActs.extend({
  args: {
    acts: [
      { icon: "search", label: "Search everything Penelope wove and unwove", name: "Search the brain", onClick: fn() },
      { icon: "add", label: "Add a note for the crew of the black ship", onClick: fn() },
      { icon: "digest", label: "Daily briefing from the harbour at Ithaca", cost: "spends", why: "needs the host", onClick: fn() },
    ],
  },
  play: async ({ canvasElement }) => {
    const rail = canvasElement.querySelector<HTMLElement>(".bk-side-rail")!;
    await expect(rail.getBoundingClientRect().width).toBe(208);
    await expect(overflowing(rail)).toEqual([]);
  },
});

/**
 * THE CONTRACT, for acts too. Without handlers there is no toolbar and no
 * stop; without `onOpenPalette` the ⌘K cap is the old picture, not a button.
 */
export const StaticActs = meta.story({
  args: { items: ITEMS, acts: ACTS },
  // A picture does not scroll (nothing in it could reach a scrolled-off row),
  // so it is given the height it needs.
  render: (args) => (
    <div style={{ display: "flex", height: 540, width: "100%" }}>
      <SideRail {...args} />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector(".bk-side-rail-middle")).toBeNull();
    await expect(canvas.queryByRole("toolbar")).toBeNull();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.textContent).toContain("Search");
    await expect(canvasElement.textContent).toContain("⌘K");
  },
});

/**
 * The pictures the visual baselines read (`tests/visual/subjects.visual.tsx`):
 * tall enough that nothing scrolls, and no play function, so no hover or
 * focus is left on screen. Expanded carries the offline briefing, the one
 * row with a chip and a reason line.
 */
const tall = (args: Parameters<typeof SideRail>[0]) => (
  <div style={{ display: "flex", height: 560, width: "100%" }}>
    <SideRail {...args} />
  </div>
);

export const ActsAtRest = meta.story({
  args: { items: wired(), acts: wiredActs("needs the host"), onOpenPalette: fn() },
  render: tall,
});

export const CollapsedActsAtRest = ActsAtRest.extend({ args: { expanded: false } });

/** Two panes at 900: the rail with acts takes its 208, and the screen the rest. */
export const TwoPaneWithActs = TwoPaneDoesNotOverflow.extend({
  args: { acts: wiredActs(), onOpenPalette: fn() },
});
