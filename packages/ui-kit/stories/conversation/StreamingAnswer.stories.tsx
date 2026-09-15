import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { StreamingAnswer } from "../../src/conversation/StreamingAnswer.js";
import { CONTROL_RING, ring, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/StreamingAnswer",
  component: StreamingAnswer,
  decorators: [stage],
  args: {
    phase: "searching",
    target: "scylla charybdis · 3 of 4 tools done",
    elapsed: "1.4s",
    text: "Circe named them in order, on the morning we sailed from Aeaea",
    cost: "~$0.03 so far",
    onStop: fn(),
  },
  argTypes: { lines: { control: { type: "number", min: 1, max: 4, step: 1 } } },
});

/**
 * The answer while it is still arriving. The phase line names what is
 * happening in the AGENT'S vocabulary — `brain_search`, not "Searching…" —
 * and the cost keeps counting, because a run that is spending money says so
 * while it spends it.
 */
export const Default = meta.story({});

export const Thinking = Default.extend({ args: { phase: "thinking", text: "", target: "no tools yet" } });
export const Fetching = Default.extend({
  args: { phase: "fetching", target: "wind forecast · outside the envelope", text: "" },
});
export const Writing = Default.extend({ args: { phase: "writing", lines: 2 } });

/** `phaseLabel` overrides the vocabulary word for a tool the map does not
 * name. The phase itself still drives everything else. */
export const CustomPhase = Default.extend({ args: { phaseLabel: "reading manifest" } });

/** No skeleton: the answer is complete enough that bars below it would promise
 * more than is coming. */
export const NoBars = Default.extend({ args: { bars: false } });

/** Not stoppable — a run already past its last tool call has nothing to stop,
 * and the cost line goes with it. */
export const NotStoppable = Default.extend({ args: { stoppable: false } });

export const Wide = Default.extend({ parameters: wide });

/**
 * `aria-live="polite"` on the phase line is one of the design's five
 * non-negotiable rules. The phase is the only thing on screen that changes
 * without the user doing anything, so without it a screen-reader user has no
 * signal that anything is happening. `polite`, not `assertive`: a phase change
 * must not cut across the answer being read.
 */
export const PhaseLineIsLive = meta.story({
  play: async ({ canvasElement }) => {
    const live = canvasElement.querySelector('[aria-live="polite"]');
    await expect(live).not.toBeNull();
    await expect(live!.textContent).toContain("brain_search");
  },
});

export const Stopped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Stop"));
    await expect(args.onStop).toHaveBeenCalled();
  },
});

/**
 * THE CONTRACT, wave 1b. Stop is small and untoned, so it takes `.bk-control`
 * with D20's literal values — `raised` ground, `#3a3e47` border, ink
 * foreground — and its ring sits outside at +2.
 */
export const StopIsAControl = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const stop = await canvas.findByRole("button", { name: "Stop" });
    await expect(stop.className).toBe("bk-control");

    await userEvent.tab();
    await expect(document.activeElement).toBe(stop);
    await expect(ring(stop)).toEqual(CONTROL_RING);

    await userEvent.keyboard("{Enter}");
    await expect(args.onStop).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onStop).toHaveBeenCalledTimes(2);

    await expect(stop.style.getPropertyValue("--hv-bd")).toBe("var(--bk-hover-border)");
  },
});

/** THE GATE. A replayed transcript shows the word without offering a tab stop
 * for an action that cannot happen any more. */
export const StopWithoutAHandler = meta.story({
  args: { onStop: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText("Stop")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
  },
});
