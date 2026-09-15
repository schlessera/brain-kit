import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { ithacaMap, straitMap, voyageMap } from "../../fixtures/places.js";
import { MapView } from "../../src/blocks/MapView.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/MapView",
  component: MapView,
  decorators: [stage],
  args: straitMap,
  argTypes: {
    spanKm: { control: { type: "number", min: 0.2, max: 4000, step: 0.1 } },
    height: { control: { type: "number", min: 110, max: 320, step: 1 } },
  },
});

/**
 * The decision, at the scale the decision was actually made: three kilometres
 * of water with a hazard on each shore, which is the entire argument. Both
 * coordinates are real, the polyline is the passage as steered, and the scale
 * bar is computed from metres-per-pixel at this latitude — so the "2 km" it
 * claims is two kilometres.
 */
export const Default = meta.story({});

/**
 * Ten years across the Mediterranean, and the story that exercises `paths` at
 * full size: a fifteen-point route already sailed in amber, and the three-point
 * leg still ahead in teal. At this span the graticule falls back to whole
 * degrees and the labels thin themselves out where they would collide with the
 * scale bar or the viewport edge.
 *
 * **`paths` is the component's one seam for real geometry.** Every `[lon, lat]`
 * polyline goes through the same Mercator projection the pins do, which is why
 * simplified coastline (D25) needs no API change here at all — it is fixture
 * data and a generation script, not a component prop. Nothing in this component
 * fetches, tiles or draws a backdrop, and it should stay that way.
 */
export const Voyage = Default.extend({
  args: voyageMap,
  play: async ({ canvasElement }) => {
    const lines = canvasElement.querySelectorAll("polyline");
    await expect(lines).toHaveLength(2);
    // Fifteen landfalls behind, three points ahead. A polyline silently short
    // of a point is the failure with no visible symptom.
    await expect(lines[0].getAttribute("points")!.split(" ")).toHaveLength(15);
    await expect(lines[1].getAttribute("points")!.split(" ")).toHaveLength(3);
  },
});

/** One pin. With nothing to bound the view, `spanKm` sets it — this is the code
 * path the single-pin shorthand (`lat`/`lon`/`pinLabel`) also takes. */
export const SinglePin = Default.extend({ args: ithacaMap });

/** The shorthand, with no `pins` array at all. */
export const Shorthand = Default.extend({
  args: {
    pins: [],
    paths: [],
    lat: 38.3647,
    lon: 20.7202,
    pinLabel: "Vathy",
    spanKm: 3,
    title: "Ithaca",
    subtitle: "the harbour, at three kilometres across",
    meta: "628 km",
  },
});

/** A pin past 62% of the width flips its label to the left of its own dot, so a
 * label near the eastern edge does not run off the card. */
export const LabelFlip = Default.extend({
  args: {
    pins: [
      { lat: 38.2507, lon: 15.719, label: "Scylla", tone: "red" },
      { lat: 38.2647, lon: 15.6508, label: "Charybdis", tone: "red" },
      { lat: 38.19, lon: 15.58, label: "open water", tone: "teal" },
    ],
    paths: [],
  },
});

/** No route. A locator with nothing to draw is still a correct locator. */
export const NoPaths = Default.extend({ args: { paths: [] } });

export const Wide = Default.extend({ parameters: wide });
