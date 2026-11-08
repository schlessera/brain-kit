/** The separate first-token story's real-browser clock controls (#1185, #3417). */
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

async function drive(host: HTMLElement, beforeInput = 0, afterInput = 0, stall?: { at: number; ms: number }) {
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
      beforeInput, afterInput, stall: stall ?? null,
      inputMs: trace.input === undefined ? null : trace.input - trace.started,
      arrivalMs: trace.arrived === undefined ? null : trace.arrived - trace.started,
      handoffMs: trace.arrived === undefined || trace.removed === undefined ? null : trace.removed - trace.arrived,
      finalMs: performance.now() - trace.started,
    }));
    observer.disconnect();
  }
}

for (const theme of ["dark", "light"]) {
  test(`${theme}: input orchestration before the first token is outside its arrival budget`, async () => {
    await withStream(theme, host => drive(host, 180));
  });

  test(`${theme}: final observation after ghost removal is outside its arrival budget`, async () => {
    await withStream(theme, host => drive(host, 0, 900));
  });

  // #3417: a long task spanning the fade's end delays the removal timer, the
  // fade's own end and every frame alike. Wall time grows by the stall; the
  // frames rendered with a faded ghost do not.
  test(`${theme}: a main-thread stall across the fade's end is outside the handoff budget`, async () => {
    await withStream(theme, host => drive(host, 0, 0, { at: 590, ms: 150 }));
  });

  test(`${theme}: a first-token ghost held 200ms past its fade still fails`, async () => {
    await withStream(theme, async host => {
      const nativeTimeout = globalThis.setTimeout;
      let handoffTimers = 0;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: unknown[]) => {
        if (args[1] === 600) { handoffTimers++; args[1] = 800; }
        return Reflect.apply(nativeTimeout, globalThis, args);
      }) as typeof nativeTimeout);
      try {
        await expect(drive(host)).rejects.toThrow(/frames rendered with the ghost after its fade ended/);
        expect(handoffTimers, "a real first-token handoff was held past its fade").toBe(1);
      } finally {
        timer.mockRestore();
      }
    });
  });

  test(`${theme}: a fade slowed to 900ms still fails on its own animation clock`, async () => {
    await withStream(theme, async host => {
      const nativeTimeout = globalThis.setTimeout;
      const slow = document.createElement("style");
      slow.textContent = ".bk-ghost-out { animation-duration: 900ms !important; }";
      document.head.append(slow);
      let handoffTimers = 0;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: unknown[]) => {
        if (args[1] === 600) { handoffTimers++; args[1] = 900; }
        return Reflect.apply(nativeTimeout, globalThis, args);
      }) as typeof nativeTimeout);
      try {
        await expect(drive(host)).rejects.toThrow(/the outgoing ghost's fade, in animation time/);
        expect(handoffTimers, "the slowed handoff was the real first-token one").toBe(1);
      } finally {
        timer.mockRestore();
        slow.remove();
      }
    });
  });
}
