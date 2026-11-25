import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { storageAll, storageAppDominant, storageBrainEmpty, storageLongNames, storagePackFolder, type StorageEntry } from "../../fixtures/storage.js";
import { StorageMap } from "../../src/storage/StorageMap.js";
import { StorageMapLegend } from "../../src/storage/StorageMapLegend.js";
import { TILE_LABEL_MIN, TILE_TARGET_MIN } from "../../src/storage/storage-geometry.js";
import { viewportAt } from "../_viewports.js";
import { Frame, legendFor, mapItemsFor, storageViewport, useWidth } from "./_storage.js";

interface MapStoryProps {
  entries: readonly StorageEntry[];
  /** Fixed height; omitted, the map is 16:10 of its width with a 180px floor. */
  height?: number;
  greyscale?: boolean;
  onOpen?: (id: string) => void;
  onUp?: () => void;
}

/** The map with its legend above it, at the frame's measured width. */
function MapStory({ entries, height, greyscale, onOpen = () => undefined, onUp = () => undefined }: MapStoryProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const legend = legendFor(entries);
  const h = height ?? Math.max(180, Math.round((width * 10) / 16));
  return (
    <Frame filter={greyscale ? "grayscale(1)" : undefined}>
      <div ref={ref} style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
        <StorageMapLegend owners={legend.owners} unknownCount={legend.unknownCount} />
        {width > 0 ? (
          <StorageMap
            items={mapItemsFor(entries, width < 600)}
            width={width}
            height={h}
            label="Storage map, All, Storage"
            descriptionId="map-story-description"
            onOpen={onOpen}
            onUp={onUp}
          />
        ) : null}
        <p id="map-story-description" style={{ margin: 0, font: "400 10.5px/1.4 'JetBrains Mono',monospace", color: "var(--bk-color-ink-mute)" }}>
          The list has every entry. Arrow keys move between tiles; Enter opens; Backspace goes up.
        </p>
      </div>
    </Frame>
  );
}

const meta = preview.meta({
  title: "Storage/StorageMap",
  component: MapStory,
  parameters: { layout: "fullscreen" },
  beforeEach: storageViewport,
  args: { entries: storageAll, onOpen: fn(), onUp: fn() },
  globals: viewportAt(320),
});

const tiles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".bk-storage-tile")];

/**
 * THE GEOMETRY RULES, measured on the laid-out tiles (storage.md): text only on
 * a tile of at least 62 × 40, a button only at 44 × 44, an edge on every tile,
 * and no hatching anywhere.
 */
async function gates(root: HTMLElement) {
  const all = tiles(root);
  await expect(all.length, "the map drew tiles").toBeGreaterThan(0);
  for (const tile of all) {
    const box = tile.getBoundingClientRect();
    const name = tile.getAttribute("aria-label") ?? tile.textContent;
    const labelled = box.width >= TILE_LABEL_MIN.width && box.height >= TILE_LABEL_MIN.height;
    await expect(tile.dataset.label !== "none", `${name}: labelled exactly when 62 x 40`).toBe(labelled && root.querySelector("[data-muted]") === null);
    if (!labelled) await expect((tile.textContent ?? "").trim(), `${name}: an unlabelled tile has no text`).toBe("");
    if (tile.tagName === "BUTTON") {
      await expect(box.width, `${name}: target width`).toBeGreaterThanOrEqual(TILE_TARGET_MIN);
      await expect(box.height, `${name}: target height`).toBeGreaterThanOrEqual(TILE_TARGET_MIN);
    } else {
      await expect(box.width < TILE_TARGET_MIN || box.height < TILE_TARGET_MIN, `${name}: a tile under 44 x 44 is not a target`).toBe(true);
    }
    for (const el of [tile, ...tile.querySelectorAll<HTMLElement>("*")])
      await expect(getComputedStyle(el).backgroundImage, "STORAGE_NO_HATCH").not.toContain("repeating");
    if (box.width > 4 && box.height > 4) await expect(tile.querySelector("svg[data-edge]"), `${name}: draws its edge`).not.toBeNull();
  }
}

/** Ownership survives without colour: each owner its own edge, each labelled tile its letter, at any width. */
async function ownership(root: HTMLElement) {
  const edges = new Map<string, Set<string>>();
  for (const tile of tiles(root)) {
    const owner = tile.dataset.owner!;
    edges.set(owner, (edges.get(owner) ?? new Set()).add(tile.dataset.edge!));
    if (tile.dataset.label === "none" || owner === "aggregate") continue;
    const cue = tile.querySelector<HTMLElement>("[data-owner-cue]")?.dataset.ownerCue;
    const width = tile.getBoundingClientRect().width;
    const expected = { brain: "B ·", app: "A ·", operator: "O ·" }[owner]!;
    await expect(cue, `${tile.getAttribute("aria-label")}: owner letter, ${Math.round(width)}px wide`).toBe(expected);
  }
  for (const [owner, set] of edges) await expect(set.size, `${owner} draws one edge style`).toBe(1);
  const styles = [...edges.values()].map((set) => [...set][0]);
  await expect(new Set(styles).size, "no two owners share an edge").toBe(styles.length);
}

/** All, at 320: App-heavy, Brain-light, an Operator backup; two unknown stores in the legend and none on the map. */
export const All = meta.story({
  play: async ({ canvasElement }) => {
    await gates(canvasElement);
    await ownership(canvasElement);
    const map = canvasElement.querySelector<HTMLElement>('[role="group"]')!;
    for (const unknown of storageAll.filter((e) => e.bytes === null))
      await expect(map.textContent + [...map.querySelectorAll("[aria-label]")].map((t) => t.getAttribute("aria-label")).join(), "STORAGE_UNKNOWN_HAS_NO_TILE").not.toContain(unknown.name);
    await expect(canvasElement.textContent).toContain("2 stores · size unknown · not drawn");
  },
});
export const AllDesktop = All.extend({ globals: viewportAt(1280) });

/** Nothing in the brain yet: Brain is "none" in the legend and draws no tile; a zero is not an area. */
export const BrainEmpty = meta.story({
  args: { entries: storageBrainEmpty },
  play: async ({ canvasElement }) => {
    await gates(canvasElement);
    await expect(tiles(canvasElement).some((t) => t.dataset.owner === "brain"), "a measured zero draws no tile").toBe(false);
    await expect(canvasElement.querySelector('[data-legend-owner="brain"]')?.textContent).toContain("none");
  },
});
export const BrainEmptyDesktop = BrainEmpty.extend({ globals: viewportAt(1280) });

/** The map #4537 reported as all hatching. Every App tile is now a dotted edge on a blue tint, and the few non-App tiles stay distinct. */
export const AppDominant = meta.story({
  args: { entries: storageAppDominant },
  play: async ({ canvasElement }) => {
    await gates(canvasElement);
    await ownership(canvasElement);
  },
});
export const AppDominantDesktop = AppDominant.extend({ globals: viewportAt(1280) });

/**
 * THE GREYSCALE CAPTURE the acceptance criteria name: App-heavy, Brain-light
 * and an Operator mix under `grayscale(1)`. Hue is gone; the edge pattern and
 * the owner letter still tell each owner apart. The visual baseline is of
 * this story.
 */
export const Greyscale = meta.story({
  args: { entries: storageAll, greyscale: true },
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(canvasElement.querySelector<HTMLElement>("[data-storage-frame]")!).filter).toBe("grayscale(1)");
    await gates(canvasElement);
    await ownership(canvasElement);
  },
});
export const GreyscaleDesktop = Greyscale.extend({ globals: viewportAt(1280) });

/** Brain, App and Operator in comparable shares, so every edge appears on a labelled tile. */
export const OperatorMix = meta.story({
  args: {
    entries: [
      { id: "attachments", name: "Attachments", owner: "brain", kind: "folder", bytes: 4.8e9 },
      { id: "packs", name: "Packs", owner: "app", kind: "folder", bytes: 4.2e9 },
      { id: "backups", name: "Backups", owner: "operator", kind: "folder", bytes: 3.9e9 },
      { id: "snapshots", name: "Snapshots", owner: "operator", kind: "folder", bytes: 2.1e9 },
      { id: "notes", name: "Voyage notes", owner: "brain", kind: "folder", bytes: 1.6e9 },
    ],
  },
  play: async ({ canvasElement }) => {
    await gates(canvasElement);
    await ownership(canvasElement);
    const owners = new Set(tiles(canvasElement).filter((t) => t.dataset.label !== "none").map((t) => t.dataset.owner));
    await expect([...owners].sort()).toEqual(["app", "brain", "operator"]);
  },
});
export const OperatorMixDesktop = OperatorMix.extend({ globals: viewportAt(1280) });

/**
 * "N smaller": 212 packs under 1% each fold into one neutral aggregate. A
 * phone shows at most six tiles plus it; it names its list.
 */
export const NSmaller = meta.story({
  args: { entries: storagePackFolder },
  play: async ({ canvasElement, args, userEvent }) => {
    await gates(canvasElement);
    const all = tiles(canvasElement);
    const aggregate = all.find((t) => t.dataset.owner === "aggregate")!;
    await expect(aggregate.dataset.edge).toBe("outline");
    await expect(aggregate.getAttribute("aria-label")).toMatch(/^\+212 smaller, .+\. Open list\.$/);
    await expect(all.length, "at most six tiles plus N smaller on a phone").toBeLessThanOrEqual(7);
    await userEvent.click(aggregate);
    await expect(args.onOpen).toHaveBeenCalledWith("smaller");
  },
});
export const NSmallerDesktop = NSmaller.extend({ globals: viewportAt(1280), play: async ({ canvasElement }) => gates(canvasElement) });

/**
 * Tiny tiles: under 62 × 40 they carry no text, under 44 × 44 they are not a
 * target, but every one still draws its edge. Their names are in the list.
 */
export const TinyTiles = meta.story({
  args: {
    height: 120,
    entries: [
      { id: "big", name: "Models", owner: "app", kind: "folder", bytes: 400 },
      ...(["brain", "app", "operator"] as const).flatMap((owner, i) =>
        [0, 1, 2].map((n): StorageEntry => ({ id: `${owner}-${n}`, name: `${owner} ${n}`, owner, kind: "folder", bytes: 3 + i + n })),
      ),
    ],
  },
  play: async ({ canvasElement }) => {
    await gates(canvasElement);
    const small = tiles(canvasElement).filter((t) => t.tagName !== "BUTTON");
    await expect(small.length, "some tiles are too small to be targets").toBeGreaterThan(0);
    for (const tile of small) await expect(tile.getAttribute("aria-hidden")).toBe("true");
  },
});
export const TinyTilesDesktop = TinyTiles.extend({ globals: viewportAt(1280) });

/** Below 400px of container the map is a 120px strip; the legend and the list carry the meaning. */
export const Strip = meta.story({
  args: { height: 120 },
  play: async ({ canvasElement }) => {
    await gates(canvasElement);
    await expect(canvasElement.querySelector<HTMLElement>('[role="group"]')!.getBoundingClientRect().height).toBe(120);
  },
});

/** Long names end in an ellipsis on a tile; the list shows two lines of them. */
export const LongNames = meta.story({ args: { entries: storageLongNames }, play: async ({ canvasElement }) => gates(canvasElement) });
export const LongNamesDesktop = LongNames.extend({ globals: viewportAt(1280) });

/**
 * ONE TAB STOP, ARROWS IN READING ORDER. Tab lands on the first target; the
 * arrows walk the targets by tile centre and wrap; Home and End reach the
 * ends; Enter opens; Backspace and Alt+↑ go up.
 */
export const ArrowKeys = meta.story({
  globals: viewportAt(1280),
  play: async ({ canvasElement, args, userEvent }) => {
    const buttons = [...canvasElement.querySelectorAll<HTMLButtonElement>("button.bk-storage-tile")].sort(
      (a, b) => Number(a.dataset.storageMapIndex) - Number(b.dataset.storageMapIndex),
    );
    await expect(buttons.length).toBeGreaterThan(2);
    await expect(buttons.filter((b) => b.tabIndex === 0), "one tab stop").toHaveLength(1);
    const centres = buttons.map((b) => b.getBoundingClientRect());
    for (let i = 1; i < centres.length; i++)
      await expect(centres[i - 1]!.top < centres[i]!.top || (centres[i - 1]!.top === centres[i]!.top && centres[i - 1]!.left < centres[i]!.left), "reading order").toBe(true);
    await userEvent.tab();
    await expect(document.activeElement).toBe(buttons[0]);
    await userEvent.keyboard("{ArrowRight}");
    await expect(document.activeElement).toBe(buttons[1]);
    await userEvent.keyboard("{ArrowDown}");
    await expect(document.activeElement).toBe(buttons[2]);
    await userEvent.keyboard("{ArrowLeft}");
    await expect(document.activeElement).toBe(buttons[1]);
    await userEvent.keyboard("{End}");
    await expect(document.activeElement).toBe(buttons.at(-1));
    await userEvent.keyboard("{ArrowRight}");
    await expect(document.activeElement, "wraps").toBe(buttons[0]);
    await expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[0]]);
    await userEvent.keyboard("{Enter}");
    await expect(args.onOpen).toHaveBeenCalledWith("packs");
    await userEvent.keyboard("{Backspace}");
    await expect(args.onUp).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await expect(args.onUp).toHaveBeenCalledTimes(2);
    await userEvent.tab();
    await expect(canvasElement.querySelector('[role="group"]')!.contains(document.activeElement), "Tab leaves the map").toBe(false);
  },
});
