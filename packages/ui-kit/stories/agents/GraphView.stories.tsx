import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { graphEdges, graphLegend, graphMeta, graphNodes } from "../../fixtures/search.js";
import { GraphView, type GraphViewProps } from "../../src/agents/GraphView.js";
import { overflowing, stage, wide } from "../_stage.js";

/**
 * A STATED WIDTH, not the stage's — D28, and this component is the reason the
 * rule has teeth.
 *
 * Every element inside `GraphView` is absolutely positioned, so the box has no
 * intrinsic width to offer a container that sizes itself to its content. The preview's
 * former centred root did exactly that, so a
 * bare `<GraphView />` rendered a 2px vertical sliver here for a whole wave
 * while all six of these stories passed: percentages of zero are all zero, so
 * nothing overflowed, no node escaped, and the edge count was right.
 *
 * The component now carries a `minWidth` floor so the failure is a narrow graph
 * rather than an invisible one. This wrapper is the other half — a story about
 * a component that fills its container owes that container a width.
 */
function boxed(width: number | string) {
  return function render(args: GraphViewProps) {
    return (
      <div style={{ width, maxWidth: "100%", boxSizing: "border-box" }}>
        <GraphView {...args} />
      </div>
    );
  };
}

const meta = preview.meta({
  title: "Agents/GraphView",
  component: GraphView,
  decorators: [stage],
  render: boxed(360),
  args: {
    nodes: graphNodes,
    edges: graphEdges,
    legend: graphLegend,
    label: "Neighbourhood",
    meta: graphMeta,
    minHeight: 240,
  },
  argTypes: { minHeight: { control: { type: "range", min: 160, max: 420, step: 10 } } },
});

/**
 * The second of the search screen's three views, and an answer to the same
 * question the result list answers. The focus node is the thing that was asked
 * about; everything else is one or two hops from it.
 */
export const Default = meta.story({});

/** Tall enough to spread out. `minHeight` is the only sizing knob — the width
 * is always the container's, because a graph in a column is a column wide. */
export const Tall = Default.extend({ args: { minHeight: 380 } });

export const Wide = Default.extend({ parameters: wide, render: boxed(760) });

/** No explicit pairs: every node is joined to the focus node and nothing else,
 * which is the shape a 1-hop neighbourhood actually has. */
export const OneHop = Default.extend({ args: { edges: [], meta: "1-hop · 8 nodes" } });

/** The chrome is optional. Without a legend the box is just the graph, which is
 * what an inline answer block wants. */
export const NoChrome = Default.extend({ args: { label: "", legend: [], meta: "" } });

/**
 * Two edge weights, and the difference is load-bearing. Every node gets a
 * brighter edge to the focus node; `edges` adds the dimmer hairline between
 * pairs. So "related to what you asked" and "related to each other" are
 * distinguishable without reading a key.
 */
export const EdgesComeInTwoWeights = meta.story({
  play: async ({ canvasElement }) => {
    const lines = [...canvasElement.querySelectorAll<SVGLineElement>("line")];
    // 7 spokes from the focus node + 10 explicit pairs.
    await expect(lines).toHaveLength(graphNodes.length - 1 + graphEdges.length);
    const strokes = new Set(lines.map((l) => getComputedStyle(l).stroke));
    await expect(strokes.size).toBe(2);
  },
});

/** The focus node is the only tinted one, and it is bigger and heavier. Node
 * colour is entity type; the focus treatment is on top of that, not instead. */
export const FocusIsDistinct = meta.story({
  play: async ({ canvas }) => {
    const focus = await canvas.findByText(graphNodes[0].label);
    const other = await canvas.findByText(graphNodes[1].label);
    await expect(getComputedStyle(focus).fontWeight).toBe("600");
    await expect(getComputedStyle(other).fontWeight).toBe("500");
    await expect(getComputedStyle(focus).backgroundColor).not.toBe(getComputedStyle(other).backgroundColor);
  },
});

/**
 * The box clips, so nothing can escape it — but a node at `x: 100` would sit
 * half outside and be silently cut. `overflowing()` cannot see through
 * `overflow: hidden`, so this asserts the node rectangles against the box
 * directly.
 */
export const NodesStayInside = meta.story({
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector("svg")!.parentElement!;
    const bounds = box.getBoundingClientRect();
    const stage = box.parentElement!.parentElement!;
    await expect(bounds.width).toBeLessThanOrEqual(stage.getBoundingClientRect().width);
    const escaped: string[] = [];
    for (const label of graphNodes.map((n) => n.label)) {
      const el = [...box.querySelectorAll<HTMLElement>("div")].find((d) => d.textContent === label);
      await expect(el, `node ${label} is present`).not.toBeUndefined();
      const r = el!.getBoundingClientRect();
      if (r.left < bounds.left - 1 || r.right > bounds.right + 1) escaped.push(`${label} is clipped horizontally`);
      if (r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1) escaped.push(`${label} is clipped vertically`);
    }
    await expect(escaped).toEqual([]);
    await expect(overflowing(box)).toEqual([]);
  },
});

/** A graph is a view, not a menu: no roles and no tab stops. Making nodes
 * navigable is the Files/Search wave's, and it needs a design first. */
export const Static = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

/**
 * THE COLLAPSE, AND THE FLOOR THAT STOPS IT.
 *
 * `GraphView` is the only component in the kit whose entire interior is
 * absolutely positioned, so its intrinsic width is zero and `width: 100%` in a
 * shrink-to-fit container resolves against a container that was waiting for
 * this box to supply the number. Both land on nothing and the graph becomes a
 * 2px sliver of its own border at full height.
 *
 * `inline-flex` here is the smallest honest reproduction of the condition —
 * Storybook's own centred root is another, and is where this actually shipped.
 *
 * The assertion is the NODE SPREAD rather than the box width, because that is
 * the thing a reader would notice: collapsed, every node sits at `left: 0` and
 * eight labels pile on one another. A box width alone would pass on a box that
 * is wide and empty.
 */
export const ItCannotCollapseInAShrinkToFitContainer = meta.story({
  render: (args) => (
    <div style={{ display: "inline-flex" }}>
      <GraphView {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector("svg")!.parentElement!;
    await expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(220);

    const xs = graphNodes.map((n) => {
      const el = [...box.querySelectorAll<HTMLElement>("div")].find((d) => d.textContent === n.label);
      return el ? el.getBoundingClientRect().left : 0;
    });
    // Eight nodes spread across 12-84% of the box. Collapsed, every one of them
    // is at the same pixel.
    await expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(100);
  },
});
