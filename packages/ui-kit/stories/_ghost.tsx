import { useState, type ReactNode } from "react";
import { expect, waitFor } from "storybook/test";

/**
 * The "Loading → ready" harness (#1116): one component, at 320px and at
 * 720px, driven through ready → loading → ready by two real buttons, so a play
 * function can measure the handoff in Chromium rather than trust it.
 *
 * It starts READY, so the second load is a re-fetch: the ghost is sized from
 * the value it is about to be replaced by, which is the case where the layout
 * must not move at all.
 */
export function Handoff({ render }: { render: (loading: boolean, width: number) => ReactNode }) {
  const [loading, setLoading] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setLoading(true)}>
          Reload
        </button>
        <button type="button" onClick={() => setLoading(false)}>
          Land
        </button>
      </div>
      {[320, 720].map((width) => (
        <div key={width} data-width={width} style={{ width, maxWidth: "100%" }}>
          {render(loading, width)}
          {/* What comes next on the page: it must not move on arrival. */}
          <div data-after="" style={{ height: 1 }} />
        </div>
      ))}
    </div>
  );
}

const frames = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-width]")].map((w) => w.firstElementChild as HTMLElement);
const afters = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-after]")].map((a) => a.getBoundingClientRect().top);
const opacity = (el: Element | null) => (el ? Number(getComputedStyle(el).opacity) : NaN);

/**
 * The browser half of #1116's acceptance, for one component:
 *   - the ghost's lines are the ready lines: the frame is the same height
 *     loading and ready, at 320px and at 720px, so nothing below it moves;
 *   - on arrival the outgoing ghost is laid over the content, not beside it;
 *   - no ghost survives 700ms after arrival.
 */
export async function playHandoff({
  canvasElement,
  canvas,
  userEvent,
}: {
  canvasElement: HTMLElement;
  canvas: { findByRole: (role: string, options: { name: string }) => Promise<HTMLElement> };
  userEvent: { click: (el: Element) => Promise<void> };
}) {
  await document.fonts?.ready;
  const ready = frames(canvasElement).map((f) => f.getBoundingClientRect());
  await expect(ready).toHaveLength(2);
  await expect(canvasElement.querySelectorAll(".bk-ghost")).toHaveLength(0);

  await userEvent.click(await canvas.findByRole("button", { name: "Reload" }));
  await waitFor(() => expect(canvasElement.querySelectorAll(".bk-ghost").length).toBeGreaterThan(0));
  const loading = frames(canvasElement);
  for (const f of loading) await expect(f.getAttribute("aria-busy")).toBe("true");
  const ghostRects = loading.map((f) => f.getBoundingClientRect());
  const ghostAfter = afters(canvasElement);

  // D53's budget starts when each frame commits its arriving layers. Locator
  // lookup and asynchronous input orchestration are not component handoff time;
  // polling after removal must not extend that interval either (#1179).
  const handoffs = loading.map(frame => ({ frame, arrived: undefined as number | undefined, removed: undefined as number | undefined }));
  const observeHandoffs = () => {
    const now = performance.now();
    for (const h of handoffs) {
      if (h.arrived === undefined && !h.frame.hasAttribute("aria-busy") && h.frame.querySelector(".bk-ghost-out")) h.arrived = now;
      if (h.arrived !== undefined && h.removed === undefined && !h.frame.querySelector(".bk-ghost, .bk-ghost-out")) h.removed = now;
    }
  };
  const observer = new MutationObserver(observeHandoffs);
  observer.observe(canvasElement, {subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"]});
  try {
    await userEvent.click(await canvas.findByRole("button", { name: "Land" }));
    const arriving = frames(canvasElement);
    const arrivedRects = arriving.map((f) => f.getBoundingClientRect());
    for (const [i, f] of arriving.entries()) {
      await expect(f.getAttribute("aria-busy")).toBeNull();
      // Same box loading and ready: the line count matched, and nothing moved.
      await expect(Math.abs(arrivedRects[i]!.height - ghostRects[i]!.height)).toBeLessThanOrEqual(1);
      await expect(Math.abs(arrivedRects[i]!.top - ghostRects[i]!.top)).toBeLessThanOrEqual(1);
      await expect(Math.abs(arrivedRects[i]!.height - ready[i]!.height)).toBeLessThanOrEqual(1);
    }
    for (const [i, top] of afters(canvasElement).entries()) await expect(Math.abs(top - ghostAfter[i]!)).toBeLessThanOrEqual(1);

    // Mid-handoff, both layers are part-way: the ghost going, the text coming.
    await new Promise((r) => setTimeout(r, 300));
    const out = opacity(canvasElement.querySelector(".bk-ghost-out"));
    const incoming = opacity(canvasElement.querySelector(".bk-ghost-in"));
    await expect(out).toBeGreaterThan(0);
    await expect(out).toBeLessThan(1);
    await expect(incoming).toBeGreaterThan(0);
    await expect(incoming).toBeLessThan(1);

    await waitFor(() => expect(canvasElement.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0), {
      timeout: 1000,
      interval: 20,
    });
    // Both widths must have entered and completed the real handoff. A missing
    // observation cannot turn into a zero-duration success.
    observeHandoffs();
    for (const h of handoffs) {
      await expect(h.arrived).toBeDefined();
      await expect(h.removed).toBeDefined();
      await expect(h.removed! - h.arrived!).toBeLessThan(700);
    }
  } finally {
    observer.disconnect();
  }
}
