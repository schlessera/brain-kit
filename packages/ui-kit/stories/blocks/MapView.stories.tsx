import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { corfuMap, gozoMap, ithacaMap, straitMap, troyMap, voyageMap } from "../../fixtures/places.js";
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

/**
 * REAL COASTLINE, AND WHY IT IS FIXTURE DATA RATHER THAN A FEATURE.
 *
 * The graticule and scale bar make an accurate locator and an unrecognisable
 * picture — a radar view. This is the same component drawing the same `paths`
 * prop it has always had; what changed is that the world now ships simplified
 * OpenStreetMap coastline for five locations (D25, `fixtures/geo/`). No tiles,
 * no network at render time, no key, no new dependency, and **no component API
 * change** beyond the credit the licence requires.
 *
 * Gozo is the one to look at: seven years on Ogygia, and the island is the one
 * shape in this world its owner could draw from memory. That is exactly what
 * coastline buys and a graticule cannot.
 */
export const Ogygia = Default.extend({ args: gozoMap });

/** Scheria at 52 km — the largest span with coastline, and the one where
 * simplification tolerance is doing the most work: 158 m per vertex, which is
 * one pixel of the render and invisible at it. */
export const Scheria = Default.extend({ args: corfuMap });

/**
 * TROY, AND THE ONE PLACE COASTLINE ALONE IS NOT ENOUGH.
 *
 * D25 measured all five by rendering them: Gozo, Corfu and Ithaca are closed
 * island silhouettes, Messina reads as a strait, and **Troy is weak** — a
 * single shoreline curve does not tell you where you are. The fix is roads
 * through the same pipeline for a few KB, not a raster: same licence, same
 * theming, same determinism. They go in a step quieter than the coast, because
 * the coast is what gives the picture its shape.
 */
export const TroyHasRoads = Default.extend({
  args: troyMap,
  play: async ({ canvasElement }) => {
    const lines = [...canvasElement.querySelectorAll<SVGPolylineElement>("polyline")];
    const widths = new Set(lines.map((l) => l.getAttribute("stroke-width")));
    // Two weights on screen: the coast and, quieter, the roads.
    await expect(widths.size).toBe(2);
    await expect(lines.length).toBeGreaterThan(100);
  },
});

/**
 * THE CREDIT IS AN OBLIGATION, AND IT IS THE CALLER'S.
 *
 * The rendered map is a Produced Work and carries no share-alike, but it must
 * still say where the shape came from. `attribution` is a prop rather than
 * something the component infers, because the component cannot know where a
 * caller's `paths` came from — a consumer drawing their own survey has nothing
 * to credit, and inventing a credit for them would be worse than omitting one.
 *
 * `tests/geo-fixtures.test.ts` is what makes forgetting loud: a scene drawing
 * this geometry without the credit fails there, not here.
 */
export const TheCreditIsRendered = Default.extend({
  args: gozoMap,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("© OpenStreetMap contributors")).toBeTruthy();
  },
});

/**
 * A map with geometry and NO title still owes its credit, so the foot row is no
 * longer gated on the title alone — and it tightens its padding when it carries
 * only the credit, because a lone 9px line in a 10px band reads as an empty row
 * rather than as a footnote.
 */
export const CreditWithoutATitle = Default.extend({
  args: { ...gozoMap, title: "", subtitle: "", meta: "" },
  play: async ({ canvas, canvasElement }) => {
    // Not `queryByText("Ogygia")`: the PIN is called Ogygia too. The foot
    // title is the card's only <b>, so its absence is the check.
    await expect(canvasElement.querySelector("b")).toBeNull();
    await expect(await canvas.findByText("© OpenStreetMap contributors")).toBeTruthy();
  },
});

/** No geometry, no credit — the component invents nothing. */
export const NoCreditWithoutGeometry = Default.extend({
  args: { ...ithacaMap, paths: [], attribution: undefined },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText("© OpenStreetMap contributors")).toBeNull();
  },
});

/**
 * A PIN STAYS ON ITS OWN COASTLINE AT EVERY WIDTH.
 *
 * The SVG scales to the card's fluid width; the pins and graticule labels are
 * absolutely-positioned overlays and do not. Placed at the projected SVG pixel
 * they drift from the geometry by however much the card differs from `width` —
 * measured at 30% of the box on a 232px card, which is a pin sitting in the sea
 * beside the island it names. It was invisible for as long as there was no
 * coastline to be wrong about, and every test in
 * `tests/mapview-projection.test.tsx` renders at exactly `width`, where pixels
 * and percentages happen to coincide.
 *
 * So the check is the one thing those cannot do: render the SAME scene at two
 * widths and compare the pin's FRACTIONAL position in its box. Percentages hold
 * it constant; pixels do not.
 *
 * It measures the DOT rather than the row, and that matters: the row used to be
 * centred on the coordinate with `translate(-50%, -50%)`, which put the dot
 * half a label away from the point it marks — 44px in a 238px card — and
 * displaced two pins by different amounts according to their label lengths, so
 * the distance between them was wrong under a scale bar claiming to measure it.
 */
export const PinsTrackTheGeometryAtAnyWidth = meta.story({
  args: gozoMap,
  parameters: wide,
  render: (args) => (
    <>
      <div style={{ width: 240 }} data-testid="narrow">
        <MapView {...args} />
      </div>
      <div style={{ width: 560 }} data-testid="roomy">
        <MapView {...args} />
      </div>
    </>
  ),
  play: async ({ canvas }) => {
    const read = (id: string) => {
      const card = canvas.getByTestId(id);
      const svg = card.querySelector("svg")!.getBoundingClientRect();
      const dot = [...card.querySelectorAll<HTMLElement>("span")].find(
        (el) => getComputedStyle(el).borderRadius === "50%",
      )!;
      const dotBox = dot.getBoundingClientRect();
      const bar = [...card.querySelectorAll<HTMLElement>("span")].find(
        (el) => getComputedStyle(el).height === "3px",
      )!;
      return {
        pin: (dotBox.left + dotBox.width / 2 - svg.left) / svg.width,
        bar: bar.getBoundingClientRect().width / svg.width,
      };
    };
    const narrow = read("narrow");
    const roomy = read("roomy");

    await expect(Math.abs(narrow.pin - roomy.pin)).toBeLessThan(0.005);
    // The scale bar too: it is an HTML overlay whose LENGTH is a claim about
    // distance, so it has to be the same fraction of the map at both widths.
    // A percentage inside a shrink-to-fit flex row resolves against the row
    // rather than the drawing and collapses to a few pixels, which is a scale
    // bar that lies rather than one that is merely ugly.
    await expect(Math.abs(narrow.bar - roomy.bar)).toBeLessThan(0.005);
    await expect(narrow.bar).toBeGreaterThan(0.05);

    // And the pin is at a real position, not both pinned to an edge.
    await expect(narrow.pin).toBeGreaterThan(0.1);
    await expect(narrow.pin).toBeLessThan(0.9);
  },
});
