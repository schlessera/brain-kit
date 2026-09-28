import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import {
  harbourEight,
  harbourTwelve,
  homeAndTroy,
  longLabels,
  noGeometry,
  placeMapProps,
  tooSpread,
} from "../../fixtures/place-maps.js";
import { PLACE_MAP_NO_GEOMETRY, PlaceMap } from "../../src/blocks/PlaceMap.js";
import { stage, wide } from "../_stage.js";

/**
 * The box a block gets in the chat on a 320px phone: the message column's
 * 16px gutters on each side (`scrollRef`,
 * `packages/ui-react/src/components/chat/chat-page.tsx`), and nothing else
 * horizontal between it and the block. `receipt-value-budget.visual.tsx`
 * derives the same 288.
 */
const phone = { stageWidth: 288 };

const meta = preview.meta({
  title: "Blocks/PlaceMap",
  component: PlaceMap,
  decorators: [stage],
  args: placeMapProps(harbourEight),
  parameters: phone,
});

type Box = { left: number; right: number; top: number; bottom: number };

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * What "legible" means for a map of numbered places, as things a browser can
 * measure: every mark sits wholly inside its drawing, no two marks cover each
 * other, every place is accounted for by a badge or a cluster, every clustered
 * place says which cluster in its row, and no text anywhere in the card is
 * clipped. Run against the laid-out card, because clustering happens at the
 * width the card is actually drawn.
 */
async function legible(root: HTMLElement, places: number) {
  const viewport = root.querySelector<HTMLElement>('[role="img"]')!;
  await expect(viewport).not.toBeNull();
  const frame = viewport.getBoundingClientRect();
  const marks = [...viewport.querySelectorAll<HTMLElement>("[data-pin]")];
  const boxes = marks.map((mark) => mark.getBoundingClientRect());
  for (const box of boxes) {
    await expect(box.left).toBeGreaterThanOrEqual(frame.left);
    await expect(box.right).toBeLessThanOrEqual(frame.right);
    await expect(box.top).toBeGreaterThanOrEqual(frame.top);
    await expect(box.bottom).toBeLessThanOrEqual(frame.bottom);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      await expect(overlaps(boxes[i]!, boxes[j]!), `${marks[i]!.textContent} covers ${marks[j]!.textContent}`).toBe(false);
    }
  }
  // Every place is a badge or a member of a cluster, and none is both.
  const badges = marks.filter((mark) => mark.dataset.pin === "badge").map((mark) => Number(mark.textContent));
  const clusters = marks
    .filter((mark) => mark.dataset.pin === "cluster")
    .map((mark) => {
      const [letter, size] = mark.textContent!.split("·");
      return { letter: letter!, size: Number(size) };
    });
  await expect(badges.length + clusters.reduce((sum, c) => sum + c.size, 0)).toBe(places);
  // Every member row names its cluster; the counts on the map and in the list agree.
  for (const cluster of clusters) {
    await waitFor(() =>
      expect(
        [...root.querySelectorAll("li[data-place]")].filter((li) => li.textContent!.includes(`in ${cluster.letter}`)),
      ).toHaveLength(cluster.size),
    );
  }
  for (const n of badges) {
    await expect(root.querySelector(`li[data-place="${n}"]`)!.textContent).not.toMatch(/ in [A-Z]+$/);
  }
  // Nothing clipped: a name that does not fit wraps, it is never cut.
  for (const el of root.querySelectorAll<HTMLElement>("li *, [data-place-line], [data-place-positions]")) {
    // The visually hidden `1. ` that numbers a row for a screen reader is
    // clipped on purpose.
    if (getComputedStyle(el).position === "absolute") continue;
    await expect(el.scrollWidth, el.textContent ?? "").toBeLessThanOrEqual(el.clientWidth + 1);
  }
}

/**
 * **Eight places in one town, on a phone.** The acceptance case: every pin is
 * a numbered badge, the two 35 m apart share one lettered badge, and both of
 * their rows say so. Every number on the map resolves to a row under it.
 */
export const EightInOneTown = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("li[data-place]")).toHaveLength(8);
    await legible(canvasElement, 8);
    // The two harbour pins are 35 m apart: at a phone's width that is one mark.
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-pin="cluster"]')).toHaveLength(1));
  },
});

/** The same eight at desktop width: more ground, same scale rule. */
export const EightInOneTownWide = EightInOneTown.extend({ parameters: wide });

/**
 * Twelve places, five in one block of the harbour. On a phone the list shows
 * eight and a disclosure that names the total: nothing is silently gone, and
 * the numbers past eight on the map resolve by opening it.
 */
export const TwelveCollapsed = meta.story({
  args: { ...placeMapProps(harbourTwelve), listOpen: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("li[data-place]")).toHaveLength(8);
    await expect(canvasElement.textContent).toContain("Show all 12 places");
  },
});

/** Twelve, open: the desktop default. */
export const Twelve = meta.story({
  args: placeMapProps(harbourTwelve),
  parameters: wide,
  play: async ({ canvasElement }) => {
    await legible(canvasElement, 12);
  },
});

/**
 * **Two places 508 km apart.** One frame would be a continent with two dots on
 * it and a coastline nobody can read, so there are two, each at its own scale
 * with its own scale bar, and a line above them saying how far apart they are.
 * One credit covers both. Stacked on a phone.
 */
export const TwoContinents = meta.story({
  args: placeMapProps(homeAndTroy),
  play: async ({ canvasElement }) => {
    const frames = [...canvasElement.querySelectorAll<HTMLElement>("[data-place-frame]")];
    await expect(frames).toHaveLength(2);
    const [a, b] = frames.map((frame) => frame.getBoundingClientRect());
    await expect(b!.top).toBeGreaterThanOrEqual(a!.bottom);
    await expect(canvasElement.textContent).toContain("Too far apart for one map · 508 km between them");
    await expect(canvasElement.textContent!.split("© OpenStreetMap contributors")).toHaveLength(2);
    await expect(canvasElement.querySelectorAll('[role="img"]')).toHaveLength(2);
  },
});

/** Side by side from a 560px card up. */
export const TwoContinentsWide = meta.story({
  args: placeMapProps(homeAndTroy),
  parameters: wide,
  play: async ({ canvasElement }) => {
    const [a, b] = [...canvasElement.querySelectorAll<HTMLElement>("[data-place-frame]")].map((frame) =>
      frame.getBoundingClientRect(),
    );
    await expect(Math.abs(a!.top - b!.top)).toBeLessThan(1);
    await expect(b!.left).toBeGreaterThanOrEqual(a!.right);
  },
});

/**
 * One name past 18 characters and every pin is numbered: labelled and
 * numbered pins together would read the numbered ones as lesser. The long
 * name wraps in the list, whole.
 */
export const LongLabels = meta.story({
  args: placeMapProps(longLabels),
  play: async ({ canvasElement }) => {
    await legible(canvasElement, 3);
    await expect(canvasElement.querySelector('[role="img"]')!.textContent).not.toContain("Naiads");
  },
});

/**
 * The route answered with nothing. A graticule with dots and no shore does not
 * locate a reader, so the frame is one line and the list is the answer; the
 * credit goes, because no OpenStreetMap data is drawn.
 */
export const NoGeometry = meta.story({
  args: placeMapProps(noGeometry),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.textContent).toContain(PLACE_MAP_NO_GEOMETRY);
    await expect(canvasElement.querySelector("svg[preserveAspectRatio]")).toBeNull();
    await expect(canvasElement.textContent).not.toContain("OpenStreetMap");
    await expect(canvasElement.querySelectorAll("li[data-place]")).toHaveLength(3);
  },
});

/** While geometry is on its way: graticule, pins and a true scale bar, no spinner. */
export const Pending = meta.story({ args: placeMapProps(harbourEight, "pending") });

/** Too spread out for one map or two: no frame, the distance across, the list. */
export const TooSpread = meta.story({
  args: placeMapProps(tooSpread),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[role="img"]')).toBeNull();
    await expect(canvasElement.textContent).toContain("Too spread out to draw · 1,140 km across");
  },
});
