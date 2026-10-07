import { useState } from "react";
import preview from "#.storybook/preview";
import { expect, fn, waitFor } from "storybook/test";

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

/** Before the first token: the answer is ghost text, `lines` blurred prose
 * lines with the spectrum sweeping through them (#1116). */
export const Waiting = Default.extend({ args: { phase: "searching", text: "", lines: 3 } });

/** `bars: false` turns the ghost off: before the first token there is only the
 * phase line, which already says what is happening. */
export const NoBars = Waiting.extend({ args: { bars: false } });

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

const TOKENS = ["Circe named", " them in order,", " on the morning", " we sailed from Aeaea."];

/**
 * Loading → ready (#1116), for a stream. The ghost sits BEHIND the text: the
 * first token lands where the ghost was and the ghost fades out under it, gone
 * within 700ms. The newest characters settle from 0.2 to full opacity and are
 * all the way there within 250ms of the last token.
 */
export const LoadingToReady = meta.story({
  render: () => {
    function Stream() {
      const [count, setCount] = useState(0);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
          <button type="button" onClick={() => setCount((n) => Math.min(TOKENS.length, n + 1))}>
            Token
          </button>
          <StreamingAnswer phase="writing" target="drafting" elapsed="2.0s" text={TOKENS.slice(0, count).join("")} />
        </div>
      );
    }
    return <Stream />;
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const prose = () => canvasElement.querySelector<HTMLElement>('[aria-busy="true"]');
    await expect(canvasElement.querySelectorAll(".bk-ghost")).toHaveLength(3);
    await expect(prose()).not.toBeNull();
    const ghostTop = canvasElement.querySelector(".bk-ghost")!.getBoundingClientRect().top;
    const stopTop = (await canvas.findByText("~$0.03 so far")).getBoundingClientRect().top;

    const token = await canvas.findByRole("button", { name: "Token" });
    const first = performance.now();
    await userEvent.click(token);
    // The first token is shorter than the ghost; nothing below it moves.
    await expect((await canvas.findByText("~$0.03 so far")).getBoundingClientRect().top).toBeCloseTo(stopTop, 0);
    // Behind, not below: the first line of text starts where the ghost did.
    const firstChar = canvasElement.querySelector(".bk-ghost-tail")!.getBoundingClientRect();
    await expect(Math.abs(firstChar.top - ghostTop)).toBeLessThanOrEqual(6);
    await expect(prose()).toBeNull();
    await waitFor(() => expect(canvasElement.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0), {
      timeout: 1000,
      interval: 20,
    });
    await expect(performance.now() - first).toBeLessThan(700);

    for (let i = 1; i < TOKENS.length; i++) await userEvent.click(token);
    const tail = [...canvasElement.querySelectorAll<HTMLElement>(".bk-ghost-tail")];
    // Just landed: the newest character is still settling.
    await expect(Number(getComputedStyle(tail[tail.length - 1]!).opacity)).toBeLessThan(1);
    await expect(tail.map((t) => t.textContent).join("")).toBe(TOKENS.join("").slice(-9));
    await new Promise((r) => setTimeout(r, 250));
    for (const t of tail) await expect(getComputedStyle(t).opacity).toBe("1");
  },
});
