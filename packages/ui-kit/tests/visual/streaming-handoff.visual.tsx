/** The separate first-token story's real-browser clock controls (#1185, #3417, #3425). */
import { expect, test, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { StreamingHandoff, playStreamingHandoff } from "../../stories/_streaming-handoff.js";
import "../../src/tokens.css";
import "../../src/theme.css";

async function withStream(theme: string, run: (host: HTMLElement) => Promise<void>) {
  const previous = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = theme;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<StreamingHandoff />));
    await run(host);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    if (previous === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = previous;
  }
}

/**
 * Block the main thread, as a loaded runner does, without touching the
 * component. Kept real time: the stall is the stimulus. It must also delay the
 * browser's own animation ends and frames, which a fake clock cannot hold back.
 */
function stallAfter(delay: number, ms: number) {
  setTimeout(() => {
    const start = performance.now();
    while (performance.now() - start < ms) { /* a long task */ }
  }, delay);
}

/** A long task in the arrival's own task, after React has committed it and
 * before the browser can render the frame that starts its fades (#3425). */
function stallNow(ms: number) {
  const start = performance.now();
  while (performance.now() - start < ms) { /* a long task */ }
}

async function drive(host: HTMLElement, beforeInput = 0, afterInput = 0, stall?: { at: number; ms: number }, commitStall = 0) {
  const trace: { started: number; input?: number; arrived?: number; removed?: number } = { started: performance.now() };
  const observe = () => {
    const now = performance.now();
    if (trace.arrived === undefined && host.querySelector(".bk-ghost-tail") && host.querySelector(".bk-ghost-out")) trace.arrived = now;
    if (trace.arrived !== undefined && trace.removed === undefined && !host.querySelector(".bk-ghost, .bk-ghost-out")) trace.removed = now;
  };
  const observer = new MutationObserver(observe);
  observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"] });
  let clicks = 0;
  try {
    await playStreamingHandoff({
      canvasElement: host,
      canvas: {
        findByRole: async () => host.querySelector("button")!,
        findByText: async text => [...host.querySelectorAll<HTMLElement>("span")].find(el => el.textContent === text)!,
      },
      userEvent: { click: async element => {
        const first = ++clicks === 1;
        if (first && beforeInput) await new Promise(resolve => setTimeout(resolve, beforeInput));
        if (first) trace.input = performance.now();
        (element as HTMLElement).click();
        if (first && commitStall) stallNow(commitStall);
        if (first && stall) stallAfter(stall.at, stall.ms);
        await new Promise(resolve => setTimeout(resolve, first ? afterInput : 0));
      } },
    });
    expect(trace.input, "the first input was dispatched").toBeDefined();
    expect(trace.arrived, "real text and its outgoing ghost committed").toBeDefined();
    expect(trace.removed, "the populated outgoing ghost was removed").toBeDefined();
    expect(host.querySelectorAll(".bk-ghost-tail")).toHaveLength(9);
    expect(host.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);
  } finally {
    console.log("STREAM_HANDOFF_CONTROL", JSON.stringify({
      beforeInput, afterInput, stall: stall ?? null, commitStall,
      inputMs: trace.input === undefined ? null : trace.input - trace.started,
      arrivalMs: trace.arrived === undefined ? null : trace.arrived - trace.started,
      handoffMs: trace.arrived === undefined || trace.removed === undefined ? null : trace.removed - trace.arrived,
      finalMs: performance.now() - trace.started,
    }));
    observer.disconnect();
  }
}

// Storybook owns light and dark parity (docs/process/theme-parity.md). The
// handoff timing never reads a colour, so each case runs in one theme.
for (const theme of ["dark", "light"]) {
  if (theme === "dark") test(`${theme}: input orchestration before the first token is outside its arrival budget`, async () => {
    await withStream(theme, host => drive(host, 180));
  });

  if (theme === "light") test(`${theme}: final observation after ghost removal is outside its arrival budget`, async () => {
    await withStream(theme, host => drive(host, 0, 900));
  });

  // #3417: a long task spanning the fade's end delays the removal timer, the
  // fade's own end and every frame alike. Wall time grows by the stall; the
  // frames rendered with a faded ghost do not.
  if (theme === "dark") test(`${theme}: a main-thread stall across the fade's end is outside the handoff budget`, async () => {
    await withStream(theme, host => drive(host, 0, 0, { at: 590, ms: 150 }));
  });

  // #3425: the fades start on the first frame after the commit. A long task
  // right after the first token's commit makes that frame late; the ghost must
  // still fade to its end, rather than be cut at 600ms from the commit.
  test(`${theme}: a long task right after the first token delays the fade, and the ghost still fades to its end`, async () => {
    await withStream(theme, host => drive(host, 0, 0, undefined, 300));
  });

  if (theme === "light") test(`${theme}: a first-token ghost held 400ms past its fade still fails`, async () => {
    await withStream(theme, async host => {
      // The handoff ends when both of its fades have. Hold the incoming fade
      // 400ms longer, so the outgoing ghost outlives its own fade. 400ms, not
      // 200: a CPU-starved browser renders a 200ms hold in as few as three
      // frames, inside the allowance.
      const hold = document.createElement("style");
      hold.textContent = ".bk-ghost-in { animation-duration: 1000ms !important; }";
      document.head.append(hold);
      try {
        await expect(drive(host)).rejects.toThrow(/frames rendered with the ghost after its fade ended/);
      } finally {
        hold.remove();
      }
    });
  });

  if (theme === "dark") test(`${theme}: a fade slowed to 900ms still fails on its own animation clock`, async () => {
    await withStream(theme, async host => {
      const nativeTimeout = globalThis.setTimeout;
      const slow = document.createElement("style");
      slow.textContent = ".bk-ghost-out { animation-duration: 900ms !important; }";
      document.head.append(slow);
      let handoffTimers = 0;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: unknown[]) => {
        if (args[1] === 600) handoffTimers++;
        return Reflect.apply(nativeTimeout, globalThis, args);
      }) as typeof nativeTimeout);
      try {
        // The component waits for the slowed fade itself (#3425); the clock
        // still rejects a fade longer than D53's 600ms.
        await expect(drive(host)).rejects.toThrow(/the outgoing ghost's fade, in animation time/);
        expect(handoffTimers, "a running fade ends the handoff, not a 600ms timer").toBe(0);
      } finally {
        timer.mockRestore();
        slow.remove();
      }
    });
  });
}
