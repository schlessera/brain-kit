/** The separate first-token story's real-browser clock controls (#1185). */
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

async function drive(host: HTMLElement, beforeInput = 0, afterInput = 0) {
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
      beforeInput, afterInput,
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

  test(`${theme}: an 800ms first-token ghost still fails the 700ms cap`, async () => {
    await withStream(theme, async host => {
      const nativeTimeout = globalThis.setTimeout;
      let handoffTimers = 0;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: unknown[]) => {
        if (args[1] === 600) { handoffTimers++; args[1] = 800; }
        return Reflect.apply(nativeTimeout, globalThis, args);
      }) as typeof nativeTimeout);
      try {
        await expect(drive(host)).rejects.toThrow(/less than 700/);
        expect(handoffTimers, "a real first-token handoff was held beyond the cap").toBe(1);
      } finally {
        timer.mockRestore();
      }
    });
  });
}
