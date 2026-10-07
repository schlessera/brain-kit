import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { corfuMap, gozoMap, ithacaMap, straitMap, troyMap, vathyMap, voyageMap } from "../../fixtures/places.js";
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
 * VATHY, AND THE STREET TIER.
 *
 * The same verified coordinate as `SinglePin`, at 1.8 km instead of 12. That
 * moves the geometry from the road tier (8–40 m/px) to the street tier (below
 * 8 m/px): every residential street comes in a third weight, quieter than
 * the roads, which are quieter than the coast. Three weights on screen is the
 * whole ladder in one card, and a block is legible where the 12 km view
 * showed a shape.
 */
export const VathyHasStreets = Default.extend({
  args: vathyMap,
  play: async ({ canvasElement }) => {
    const lines = [...canvasElement.querySelectorAll<SVGPolylineElement>("polyline")];
    const widths = new Set(lines.map((l) => l.getAttribute("stroke-width")));
    await expect(widths.size).toBe(3);
    // 118 streets inside the 1.5 x 1.0 envelope (159 under the old square
    // bleed): the bar is "a block of streets", not the exact count.
    await expect(lines.length).toBeGreaterThan(100);
    await expect(canvasElement.textContent).toContain("OpenStreetMap");
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
 * The map's own SVG — the first in the card. The foot row's Icon is an SVG
 * too, and `graph` draws a `<circle>`, so "no ring" has to be asked of the
 * drawing rather than of the card.
 */
function mapSvg(root: HTMLElement): SVGSVGElement {
  return root.querySelector("svg")!;
}

/** The scale bar's label and its drawn length, which together give metres
 * per CSS pixel — read from the render, not from the arithmetic. The length
 * is the CONTENT width: the two end caps are 1px borders outside it, and the
 * percentage the bar claims is the content. */
function scale(root: HTMLElement): { text: string; px: number } {
  const bar = [...root.querySelectorAll<HTMLElement>("span")].find(
    (el) => getComputedStyle(el).height === "3px",
  )!;
  return { text: bar.nextElementSibling!.textContent!.trim(), px: parseFloat(getComputedStyle(bar).width) };
}

/** An SVG length as the reader sees it: the viewBox is the projection's own
 * width, which is the card's once it has been measured and the 330 fallback
 * before that, so the ratio is what converts either to CSS pixels. */
function cssPx(svg: SVGSVGElement, units: number): number {
  return units * (svg.getBoundingClientRect().width / svg.viewBox.baseVal.width);
}

/**
 * THE UNCERTAINTY IS DRAWN.
 *
 * A pin without it claims a precision the fix does not have, so `accuracyM`
 * is a ring around the first pin at true projected scale — amber at 10%
 * with a 45% hairline, under the route and over the graticule. The span
 * becomes `max(spanKm, 6 × accuracyM)`, a max rather than a "coarse" branch,
 * which is what widens the frame from the 1.6 km default to 3.6 km here and
 * moves the scale bar from 500 m to 1 km. The play compares that against
 * the same pin with no accuracy, and checks the ring's radius against the
 * scale bar rather than against the prop: both are drawn on the same scale,
 * so the ring converts back through the bar to the metres it claims.
 */
export const AccuracyRing = meta.story({
  args: { ...ithacaMap, spanKm: undefined, accuracyM: 600 },
  render: (args) => (
    <>
      <div style={{ width: "100%" }} data-testid="coarse">
        <MapView {...args} />
      </div>
      <div style={{ width: "100%" }} data-testid="exact">
        <MapView {...args} accuracyM={undefined} />
      </div>
    </>
  ),
  play: async ({ canvas }) => {
    const coarse = canvas.getByTestId("coarse");
    const exact = canvas.getByTestId("exact");
    const rings = mapSvg(coarse).querySelectorAll("circle");
    await expect(rings).toHaveLength(1);
    await expect(mapSvg(exact).querySelectorAll("circle")).toHaveLength(0);

    // The ring and the bar are drawn on the same scale, so the ring's radius
    // ON SCREEN, against the bar's length on screen, is the 600 m it claims.
    const bar = scale(coarse);
    const metres = bar.text.endsWith("km") ? parseFloat(bar.text) * 1000 : parseFloat(bar.text);
    const mPerPx = metres / bar.px;
    const r = cssPx(mapSvg(coarse), Number(rings[0].getAttribute("r")));
    await expect(Math.abs(r - 600 / mPerPx)).toBeLessThan(1);
    await expect(r * 2).toBeGreaterThanOrEqual(14);

    // And the span widened: six radii is 3.6 km against a 1.6 km default.
    await expect(bar.text).toBe("1 km");
    await expect(scale(exact).text).toBe("500 m");
  },
});

/**
 * A FIX TOO PRECISE TO DRAW. At 1.6 km across, 20 m is seven pixels of ring
 * — inside the pin's own glow — so nothing is drawn: at that size the pin
 * already is the uncertainty. The 14px floor is in
 * `tests/mapview-projection.test.tsx`; this is the render agreeing.
 */
export const AccuracyTooFineToDraw = Default.extend({
  args: { ...ithacaMap, spanKm: undefined, accuracyM: 20 },
  play: async ({ canvasElement }) => {
    await expect(mapSvg(canvasElement).querySelectorAll("circle")).toHaveLength(0);
    await expect(scale(canvasElement).text).toBe("500 m");
  },
});

/**
 * THE AGENT'S OWN SENTENCE, inside the card. Prose in the body font — not the
 * mono line, which is machine fact — under a hairline below the foot row,
 * because a loose line under a card belongs to nothing and the transcript
 * already reads a gap as a new block.
 */
export const WithNote = Default.extend({
  args: {
    ...ithacaMap,
    accuracyM: 350,
    note: "The fix is the harbour front rather than the hall itself; the hall is a street back from the quay, and the 350 m the phone gave covers both.",
  },
  play: async ({ canvas, canvasElement }) => {
    const note = await canvas.findByText(/The fix is the harbour front/);
    // Inside the card: the note's parent is the card, and the card is the
    // map's grandparent.
    await expect(note.parentElement).toBe(mapSvg(canvasElement).parentElement!.parentElement);
    // Under the foot row, which is the element before it.
    await expect(note.previousElementSibling!.textContent).toContain("Ithaca");
  },
});

/**
 * CAPPED AT 420. Past that the graticule spaces out into decoration and the
 * card starts competing with the answer it belongs to; narrower panes get
 * 100%. Measured in the unconstrained stage, where the cap is the only thing
 * stopping the card at the canvas edge.
 */
export const MaxWidth = Default.extend({
  parameters: wide,
  play: async ({ canvasElement }) => {
    const card = mapSvg(canvasElement).parentElement!.parentElement!;
    const available = card.parentElement!.getBoundingClientRect().width;
    await expect(available).toBeGreaterThan(0);
    // At the cap on desktop; filling the actual stage on a narrow iframe.
    await expect(Math.abs(card.getBoundingClientRect().width - Math.min(420, available))).toBeLessThan(1);
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

/**
 * THE VIEWPORT IS CLAMPED TO 110-260px, whatever `height` says.
 *
 * Aspect is bounded so the server's geometry envelope can be too: a card is
 * at most 420px wide and its viewport runs 110-260px tall. The widest card
 * (420x110) draws 1.24x the span across and 0.32x down; the tallest (420x260)
 * draws 0.77x down. An envelope of 1.5x wide and 1.0x tall therefore covers
 * every card that can exist — but only if no caller can ask for a viewport
 * outside it, which is what these two assert. A screen that passed 88 now
 * renders at 110.
 */
export const HeightIsClamped = meta.story({
  render: (args) => (
    <>
      <MapView {...args} height={40} />
      <MapView {...args} height={400} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const viewports = [...canvasElement.querySelectorAll('svg[preserveAspectRatio="none"]')].map((svg) => svg.parentElement!);
    await expect(viewports).toHaveLength(2);
    await expect(viewports.map((el) => getComputedStyle(el).height)).toEqual(["110px", "260px"]);
  },
});
