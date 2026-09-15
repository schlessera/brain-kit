import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { documentCount } from "../../fixtures/files.js";
import { orbitAgents } from "../../fixtures/runs.js";
import { AgentOrbit } from "../../src/agents/AgentOrbit.js";
import { overflowing, stage } from "../_stage.js";

const meta = preview.meta({
  title: "Agents/AgentOrbit",
  component: AgentOrbit,
  decorators: [stage],
  parameters: { stageWidth: "none" },
  args: {
    agents: orbitAgents,
    coreIcon: "brain",
    coreMeta: `${documentCount.toLocaleString("en-US")} docs`,
  },
  argTypes: {
    width: { control: { type: "range", min: 260, max: 520, step: 4 } },
    height: { control: { type: "range", min: 220, max: 420, step: 4 } },
  },
});

/**
 * Distance from the core is how far from done a run is. The two agents nearest
 * the core are nearly finished; the one out on the third ring failed early and
 * has been sitting there since.
 */
export const Default = meta.story({});

/** Collapsed to the smallest size the design's own range allows. `rMax` follows
 * the SHORTER side, so a wide, short orbit still keeps its pills inside. */
export const Small = Default.extend({ args: { width: 280, height: 230 } });

export const Large = Default.extend({ args: { width: 460, height: 380 } });

/** One agent, about to land: `orbit: 0` is the core's own edge, not the core. */
export const AboutToLand = Default.extend({
  args: { agents: [{ name: "ledger", icon: "ledger", tone: "teal", meta: "99%", state: "running", orbit: 0, angle: 0 }] },
});

/** Nothing running. The rings and the core stay, because the corpus is still
 * there — an empty orbit is a quiet brain, not a broken screen. */
export const Idle = Default.extend({ args: { agents: [] } });

/**
 * The placement, asserted in the browser rather than only in `bun test`.
 *
 * `tests/agentorbit-placement.test.tsx` checks the arithmetic against
 * hand-computed values through `renderToStaticMarkup`; this checks that the
 * same numbers survive a real layout — a pill is centred on its point by
 * `translate(-50%,-50%)`, so its measured centre is what the maths predicts and
 * its `left` is not.
 */
export const PlacementIsPolar = meta.story({
  args: { width: 340, height: 284, agents: orbitAgents },
  play: async ({ canvasElement }) => {
    const stageEl = canvasElement.querySelector<HTMLElement>("div")!;
    const box = stageEl.querySelector<HTMLElement>("div")!;
    const origin = box.getBoundingClientRect();
    const pills = [...box.querySelectorAll<HTMLElement>(":scope > div")].slice(4);
    await expect(pills).toHaveLength(4);

    const centre = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - origin.left, y: r.top + r.height / 2 - origin.top };
    };

    // researcher: orbit 0.28, angle 34 -> (210.53, 81.91). Computed from the
    // definitions, not read off this render.
    const researcher = centre(pills[0]);
    await expect(Math.abs(researcher.x - 210.53) < 1).toBe(true);
    await expect(Math.abs(researcher.y - 81.91) < 1).toBe(true);

    // source-watch: orbit 0.92, angle 214 -> (87.96, 263.64).
    const watcher = centre(pills[2]);
    await expect(Math.abs(watcher.x - 87.96) < 1).toBe(true);
    await expect(Math.abs(watcher.y - 263.64) < 1).toBe(true);
  },
});

/**
 * Motion is reserved for the breathing dots. Two of the four runs are live, so
 * exactly two dots breathe and nothing else in the component animates — one
 * ambient animation per screen is on the design's "what never changes" list.
 */
export const OnlyTheDotsMove = meta.story({
  play: async ({ canvasElement }) => {
    const animated = [...canvasElement.querySelectorAll<HTMLElement>("*")].filter(
      (el) => getComputedStyle(el).animationName !== "none",
    );
    await expect(animated).toHaveLength(2);
    for (const el of animated) {
      await expect(getComputedStyle(el).animationName).toBe("breathe");
      // 7px dots, which is what `mark` exists for.
      await expect(el.getBoundingClientRect().width).toBe(7);
    }
  },
});

/** A fixed-size stage is exactly the shape that can spill: the pills sit on
 * absolute coordinates and nothing clips them. */
export const FitsItsBox = meta.story({
  args: { width: 340, height: 284 },
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>("div > div")!;
    await expect(overflowing(box)).toEqual([]);
  },
});
