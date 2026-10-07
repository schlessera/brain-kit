import preview from "#.storybook/preview";
import { expect } from "storybook/test";

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
    coreMeta: `${orbitAgents.length} agents`,
  },
  argTypes: {
    width: { control: { type: "range", min: 260, max: 520, step: 4 } },
    height: { control: { type: "range", min: 220, max: 420, step: 4 } },
  },
});

/** Three state rings: needs you, running, ended. Never progress. */
export const Default = meta.story({ args: { agents: orbitAgents } });

/** Phone marks retain state and counts; the host list owns interaction. */
export const Small = Default.extend({ args: { width: 280, height: 236, compact: true } });

export const Large = Default.extend({ args: { width: 460, height: 380 } });

/** A pending approval belongs to the inner needs-you ring. */
export const NeedsApproval = Default.extend({ args: { agents: [{ id: "pending-ledger", name: "ledger", state: "waiting", meta: "needs approval" }], coreMeta: "1 agent" } });
export const Idle = Default.extend({ args: { agents: [] } });
export const StateRings = meta.story({
  args: { agents: orbitAgents },
  play: async ({ canvasElement }) => {
    const waiting = canvasElement.querySelector('[data-orbit-agent="agent-filer"]');
    const running = canvasElement.querySelector('[data-orbit-agent="agent-researcher"]');
    await expect(waiting?.getAttribute("data-orbit-ring")).toBe("0");
    await expect(running?.getAttribute("data-orbit-ring")).toBe("1");
    await expect(canvasElement.textContent).not.toContain("%");
    await expect(canvasElement.querySelector('[data-orbit-legend]')?.textContent).toBe("needs you 1running 1ended 2");
  },
});

/**
 * Motion is reserved for the breathing dots. Two of the four runs are live, so
 * exactly two dots breathe and nothing else in the component animates — one
 * ambient animation per screen is on the design's "what never changes" list.
 */
export const OnlyTheDotsMove = meta.story({
  args: { agents: orbitAgents },
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
  args: { agents: orbitAgents, width: 340, height: 284 },
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>("[data-orbit-frame]")!;
    await expect(overflowing(box)).toEqual([]);
  },
});
