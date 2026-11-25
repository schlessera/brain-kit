import preview from "#.storybook/preview";
import { expect, fn, waitFor } from "storybook/test";

import {
  storageAll,
  storageAppDominant,
  storageBrainEmpty,
  storageDrillTrail,
  storageLargeFiles,
  storageLongNames,
  storagePackFolder,
  storagePartial,
} from "../../fixtures/storage.js";
import { IconButton } from "../../src/primitives/IconButton.js";
import { storageUnknownReason } from "../../src/storage/storage-copy.js";
import { viewportAt } from "../_viewports.js";
import { Breakdown, Frame, LargeFiles, pageOverflow, storageViewport, type BreakdownProps } from "./_storage.js";

function BreakdownStory({ greyscale, ...props }: BreakdownProps & { greyscale?: boolean }) {
  return (
    <Frame filter={greyscale ? "grayscale(1)" : undefined}>
      <Breakdown {...props} />
    </Frame>
  );
}

const meta = preview.meta({
  title: "Storage/Breakdown",
  component: BreakdownStory,
  parameters: { layout: "fullscreen" },
  beforeEach: storageViewport,
  args: { entries: storageAll, summary: true, onDrill: fn(), onInspect: fn(), onUp: fn(), onNavigate: fn() },
  globals: viewportAt(320),
});

const map = (root: HTMLElement) => root.querySelector<HTMLElement>('[role="group"][aria-label^="Storage map"]');
const tileNames = (root: HTMLElement) => [...(map(root)?.querySelectorAll(".bk-storage-tile") ?? [])].map((t) => `${t.getAttribute("aria-label") ?? ""} ${t.textContent}`).join("\n");
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.bk-storage-body > [role="row"]')];

/** Every target the breakdown draws is at least 44 × 44, and nothing scrolls sideways. */
async function targets(root: HTMLElement, zoom = 1) {
  await expect(pageOverflow(), "STORAGE_NO_HORIZONTAL_SCROLL").toBeLessThanOrEqual(0);
  const controls = root.querySelectorAll<HTMLElement>(".bk-storage-row-main, .bk-storage-sort, .bk-storage-check, [data-storage-breadcrumb] button, .bk-storage-legend-jump");
  for (const el of controls) {
    if (el.matches("span.bk-storage-sort")) continue;
    // Under CSS zoom a client rect is in zoomed pixels; the 44px rule is in CSS pixels.
    const box = el.getBoundingClientRect();
    await expect(box.height / zoom, `${el.textContent?.slice(0, 30)}: 44px tall`).toBeGreaterThanOrEqual(44);
    await expect(box.width / zoom, `${el.textContent?.slice(0, 30)}: 44px wide`).toBeGreaterThanOrEqual(44);
  }
}

/**
 * THE LIST IS EQUIVALENT TO THE MAP. Every entry has a row, an unknown one
 * with its reason and no tile; every tile has a row; the legend's unknown
 * chip jumps to the first `?` row; a row under focus rings its tile.
 */
async function equivalent(root: HTMLElement, entries: typeof storageAll, userEvent: { click: (el: Element) => Promise<void>; tab: () => Promise<void> }) {
  const listText = rows(root).map((r) => r.textContent).join("\n");
  const drawn = tileNames(root);
  for (const entry of entries) {
    if (entry.bytes === null) {
      const row = rows(root).find((r) => r.textContent?.includes(entry.name))!;
      await expect(row, `${entry.name} has a row`).toBeTruthy();
      await expect(row.dataset.unknown).toBe("true");
      await expect(row.textContent, `${entry.name}: reason`).toContain(storageUnknownReason(entry.reason));
      await expect(drawn, `STORAGE_UNKNOWN_HAS_NO_TILE: ${entry.name}`).not.toContain(entry.name);
    } else if (drawn.includes(entry.name)) {
      await expect(listText, `${entry.name}: drawn and listed`).toContain(entry.name);
    }
  }
  for (const tile of map(root)?.querySelectorAll<HTMLElement>("button.bk-storage-tile") ?? []) {
    const name = tile.getAttribute("aria-label")!.split(",")[0]!;
    await expect(listText, `tile ${name} has a row`).toContain(name);
  }
  const jump = root.querySelector<HTMLButtonElement>(".bk-storage-legend-jump");
  if (jump) {
    await userEvent.click(jump);
    await expect(document.activeElement?.closest('[role="row"]'), "the legend jumps to the first ? row").toBe(rows(root).find((r) => r.dataset.unknown === "true"));
  }
  const first = rows(root).find((r) => r.dataset.owner !== "aggregate" && !r.dataset.unknown);
  const button = first?.querySelector<HTMLButtonElement>("button");
  if (button && map(root)) {
    button.focus();
    const name = button.getAttribute("aria-label")!.split(",")[0]!;
    await waitFor(() => expect(map(root)!.querySelector('[data-highlighted="true"]')?.getAttribute("aria-label") ?? "").toContain(name));
  }
}

/** All, with the "What this app added" row: App-heavy, two unknown stores listed and not drawn. */
export const All = meta.story({
  play: async ({ canvasElement, userEvent }) => {
    await targets(canvasElement);
    await equivalent(canvasElement, storageAll, userEvent);
    await expect(canvasElement.querySelector("[data-storage-summary]")?.textContent).toBe("What this app added··+3.4 GB·7 d");
    await expect(canvasElement.querySelector("[data-sparkline-stub]"), "the sparkline arrives as a node").not.toBeNull();
    await expect(canvasElement.querySelector("[data-storage-breakdown]")?.getAttribute("data-layout")).toBe("strip");
  },
});
export const AllDesktop = All.extend({
  globals: viewportAt(1280),
  play: async ({ canvasElement, userEvent }) => {
    await targets(canvasElement);
    await equivalent(canvasElement, storageAll, userEvent);
    await expect(canvasElement.querySelector("[data-storage-breakdown]")?.getAttribute("data-layout"), "side by side from 840px").toBe("side");
  },
});

/** Sorting: the Size header carries `aria-sort`; Name takes it over; an unknown stays last both ways. */
export const Sorting = meta.story({
  globals: viewportAt(1280),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const header = (name: string) => canvas.getByRole("button", { name }).closest('[role="columnheader"]')!;
    await expect(header("Size")).toHaveAttribute("aria-sort", "descending");
    await expect(header("Name")).not.toHaveAttribute("aria-sort");
    await userEvent.click(canvas.getByRole("button", { name: "Name" }));
    await expect(header("Name")).toHaveAttribute("aria-sort", "descending");
    await expect(header("Size")).not.toHaveAttribute("aria-sort");
    await userEvent.click(canvas.getByRole("button", { name: "Name" }));
    await expect(header("Name")).toHaveAttribute("aria-sort", "ascending");
    const order = rows(canvasElement).map((r) => r.dataset.unknown === "true");
    await expect(order.indexOf(true), "unknown rows sort last").toBe(order.length - order.filter(Boolean).length);
  },
});

/** Nothing in the brain yet: Brain categories are listed as "none" and draw no tile. */
export const BrainEmpty = meta.story({
  args: { entries: storageBrainEmpty, summary: false },
  play: async ({ canvasElement, userEvent }) => {
    await targets(canvasElement);
    await equivalent(canvasElement, storageBrainEmpty, userEvent);
    await expect(tileNames(canvasElement)).not.toContain("Voyage notes");
    await expect(rows(canvasElement).find((r) => r.textContent?.includes("Voyage notes"))?.querySelector(".bk-storage-size")?.textContent).toBe("none");
  },
});
export const BrainEmptyDesktop = BrainEmpty.extend({ globals: viewportAt(1280) });

/** App dominant, under `grayscale(1)`: edges and owner letters tell the owners apart. */
export const AppDominantGreyscale = meta.story({
  args: { entries: storageAppDominant, greyscale: true },
  play: async ({ canvasElement }) => {
    await targets(canvasElement);
    const edges = new Set([...map(canvasElement)!.querySelectorAll<HTMLElement>(".bk-storage-tile")].map((t) => `${t.dataset.owner}:${t.dataset.edge}`));
    await expect([...edges].sort()).toEqual(["app:dotted", "brain:solid", "operator:dashed"]);
  },
});
export const AppDominantGreyscaleDesktop = AppDominantGreyscale.extend({ globals: viewportAt(1280) });

/**
 * Drilled three levels: Storage › Packs › objects › pack. Every crumb is a
 * 44px target; Backspace in the list goes up; the current folder's Open sits
 * in the breadcrumb's `⋯` menu, not on a row.
 */
export const DrilledThreeLevels = meta.story({
  args: {
    entries: storagePackFolder,
    trail: storageDrillTrail,
    summary: false,
    crumbActions: <IconButton name="pack actions" icon="more" haspopup="menu" onClick={() => undefined} />,
  },
  play: async ({ canvas, canvasElement, args, userEvent }) => {
    await targets(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Storage location" });
    await expect(nav.querySelector('[aria-current="location"]')?.textContent).toBe("pack");
    await userEvent.click(canvas.getByRole("button", { name: "Packs" }));
    await expect(args.onNavigate).toHaveBeenCalledWith("packs");
    await expect(canvas.getByRole("button", { name: "pack actions" })).toHaveAttribute("aria-haspopup", "menu");
    const firstRow = rows(canvasElement)[0]!.querySelector("button")!;
    firstRow.focus();
    await userEvent.keyboard("{Backspace}");
    await expect(args.onUp).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Enter}");
    await expect(args.onInspect).toHaveBeenCalledWith("pack-3f2a");
    const aggregate = rows(canvasElement).find((r) => r.dataset.owner === "aggregate")!;
    await expect(aggregate.textContent).toContain("+212 smaller");
    await userEvent.click(aggregate.querySelector("button")!);
    await expect(args.onDrill).toHaveBeenCalledWith("smaller");
  },
});
export const DrilledThreeLevelsDesktop = DrilledThreeLevels.extend({ globals: viewportAt(1280) });

/** N smaller: the folded packs are one neutral tile and one row, never 212 slivers. */
export const NSmaller = meta.story({
  args: { entries: storagePackFolder, summary: false },
  play: async ({ canvasElement }) => {
    await targets(canvasElement);
    const tile = map(canvasElement)!.querySelector<HTMLElement>('[data-owner="aggregate"]')!;
    await expect(tile.dataset.edge).toBe("outline");
    await expect(rows(canvasElement).filter((r) => r.dataset.owner === "aggregate")).toHaveLength(1);
    await expect(rows(canvasElement).length, "the list folds the same items the map does").toBeLessThan(20);
  },
});
export const NSmallerDesktop = NSmaller.extend({ globals: viewportAt(1280) });

/** Search with no results: the list says so, in which folder; the map is muted context with a caption. */
export const SearchNoResults = meta.story({
  args: { entries: storageAll, trail: storageDrillTrail.slice(0, 2), summary: false, noMatchesFor: "vacation" },
  play: async ({ canvasElement }) => {
    await targets(canvasElement);
    await expect(canvasElement.textContent).toContain("No files or folders match “vacation” in Storage › Packs.");
    await expect(canvasElement.textContent).toContain("Map shows Packs · search matches none");
    await expect(map(canvasElement)!.dataset.muted).toBe("true");
    for (const tile of map(canvasElement)!.querySelectorAll(".bk-storage-tile")) await expect(tile.textContent).toBe("");
  },
});
export const SearchNoResultsDesktop = SearchNoResults.extend({ globals: viewportAt(1280) });

/** A partial scan: one `≥` lower bound, five unknown stores, one per reason, each a row and none a tile. */
export const PartialWithUnknown = meta.story({
  args: { entries: storagePartial, summary: false },
  play: async ({ canvasElement, userEvent }) => {
    await targets(canvasElement);
    await equivalent(canvasElement, storagePartial, userEvent);
    await expect(canvasElement.textContent).toContain("5 stores · size unknown · not drawn");
    await expect(canvasElement.textContent).toContain("≥ 4.20 GB");
  },
});
export const PartialWithUnknownDesktop = PartialWithUnknown.extend({ globals: viewportAt(1280) });

/** Find large files with two selected: the checkbox and inspect cells and the sticky selection bar. */
export const FilterWithSelection = meta.story({
  render: () => (
    <Frame>
      <LargeFiles files={storageLargeFiles} initial={["model", "export"]} />
    </Frame>
  ),
  play: async ({ canvas, canvasElement }) => {
    await targets(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("2 selected · 5.00 GB on disk");
    await expect(getComputedStyle(canvasElement.querySelector<HTMLElement>(".bk-storage-selection")!).position).toBe("sticky");
    await expect(canvas.getByRole("button", { name: "Review removal" })).toBeVisible();
  },
});
export const FilterWithSelectionDesktop = FilterWithSelection.extend({
  globals: viewportAt(1280),
  play: async ({ canvasElement }) => {
    await targets(canvasElement);
    // From 640px of list the three lines collapse to one row of columns.
    const row = canvasElement.querySelector<HTMLElement>(".bk-storage-filter-main")!;
    const name = row.querySelector(".bk-storage-f-name")!.getBoundingClientRect();
    const elig = row.querySelector(".bk-storage-f-elig")!.getBoundingClientRect();
    await expect(elig.left, "eligibility is a column beside the name").toBeGreaterThan(name.right);
  },
});

/** Long names: two lines then an ellipsis in the list, an ellipsis on a tile; no sideways scroll. */
export const LongNames = meta.story({
  args: { entries: storageLongNames, summary: false },
  play: async ({ canvasElement }) => targets(canvasElement),
});
export const LongNamesDesktop = LongNames.extend({ globals: viewportAt(1280) });

/**
 * 200% ZOOM AT 320: the page is 160 CSS px wide. Rows, crumbs and the legend
 * wrap; nothing scrolls sideways; every target stays 44px.
 */
export const Zoom200 = meta.story({
  args: { entries: storagePartial, trail: storageDrillTrail, summary: true },
  play: async ({ canvasElement }) => {
    const zoom = document.documentElement.style.zoom;
    document.documentElement.style.zoom = "2";
    try {
      await waitFor(() => expect(canvasElement.querySelector("[data-storage-breakdown]")!.getBoundingClientRect().width / 2, "the layout is 160 CSS px wide").toBeLessThan(160));
      // The map and rows re-measure through a ResizeObserver; let that settle.
      await waitFor(() => expect(pageOverflow(), "STORAGE_NO_HORIZONTAL_SCROLL at 200%").toBeLessThanOrEqual(0));
      await targets(canvasElement, 2);
    } finally {
      document.documentElement.style.zoom = zoom;
    }
  },
});

/** The filter rows at 200% zoom: three lines, wrapping, with the bar still in reach. */
export const FilterZoom200 = FilterWithSelection.extend({
  play: async ({ canvasElement }) => {
    const zoom = document.documentElement.style.zoom;
    document.documentElement.style.zoom = "2";
    try {
      await waitFor(() => expect(canvasElement.querySelector(".bk-storage-list")!.getBoundingClientRect().width / 2, "the layout is 160 CSS px wide").toBeLessThan(160));
      await waitFor(() => expect(pageOverflow(), "STORAGE_NO_HORIZONTAL_SCROLL at 200%").toBeLessThanOrEqual(0));
      await targets(canvasElement, 2);
    } finally {
      document.documentElement.style.zoom = zoom;
    }
  },
});
