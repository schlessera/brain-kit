import { useState, type ReactNode } from "react";
import { expect, waitFor } from "storybook/test";
import { TextButton } from "../src/primitives/TextButton.js";
import { FADE_MS, FRAMES_AFTER_FADE, watchHandoff } from "./_handoff-clock.js";

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
        <TextButton label="Reload" onClick={() => setLoading(true)} />
        <TextButton label="Land" onClick={() => setLoading(false)} />
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
 *   - each outgoing ghost fades over the approved 600ms and is gone within
 *     three rendered frames of its fade's end (#3417).
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

  // D53's budget starts when each frame commits its arriving layers, and is
  // counted in that page's rendered frames (#3417). Locator lookup and input
  // orchestration are not component handoff time (#1179); polling after
  // removal and a stalled runner cannot extend the interval either.
  const handoffs = loading.map(frame => ({ frame, clock: watchHandoff(frame, f => !f.hasAttribute("aria-busy") && f.querySelector(".bk-ghost-out") !== null) }));
  try {
    await userEvent.click(await canvas.findByRole("button", { name: "Land" }));
    // The geometry is read now, in the arrival's own task neighbourhood, and
    // asserted after the mid-fade sample: an awaited assertion is an
    // instrumented round trip that costs 40-300ms on a loaded runner.
    const arriving = frames(canvasElement);
    const arrivedBusy = arriving.map((f) => f.getAttribute("aria-busy"));
    const arrivedRects = arriving.map((f) => f.getBoundingClientRect());
    const arrivedAfter = afters(canvasElement);

    // Mid-handoff, both layers are part-way: the ghost going, the text coming.
    // The clock samples this on the page's own frames, from the fade's start
    // (#3755). A wait counted from the click cannot: on a loaded runner the
    // click resolves up to ~375ms after the frame commits its arriving layers
    // (sometimes after the whole fade), so a fixed 300ms wait from there landed
    // 370-770ms into the 600ms fade, after the ghost was gone. The harness
    // controls' height only shifted that by luck. A later point in the fade is
    // no safer: the ghost is removed on a timer started at the commit, and a
    // saturated browser can start the CSS animation 300ms late, so the window
    // both clocks agree on opens with the fade itself.
    const sampledFrame = handoffs[0]!;
    // React commits the arrival inside the click, so it is observable now;
    // without an outgoing layer there is no handoff to wait for.
    sampledFrame.clock.observe();
    await expect(sampledFrame.clock.arrived, "320px: arriving layers committed over the ghost").toBe(true);
    await sampledFrame.clock.settled;
    const sampledAt = performance.now();
    const mid = sampledFrame.clock.midFade;
    const out = mid?.out ?? NaN;
    const incoming = mid?.incoming ?? NaN;
    try {
      await expect(out).toBeGreaterThan(0);
      await expect(out).toBeLessThan(1);
      await expect(incoming).toBeGreaterThan(0);
      await expect(incoming).toBeLessThan(1);
    } catch (error) {
      // Read native animation state only AFTER the original oracle fails; the
      // clock's own frame sample is the only read during the fade.
      // Diagnostic failures must never replace the original assertion error.
      try {
        const captureDocument = (view: Window) => ({
          visibilityState: view.document.visibilityState, hasFocus: view.document.hasFocus(),
          viewport: { width: view.innerWidth, height: view.innerHeight, scrollX: view.scrollX, scrollY: view.scrollY },
        });
        const captureAncestor = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = element.ownerDocument.defaultView!.getComputedStyle(element);
          return {
            tag: element.tagName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display, visibility: style.visibility, contentVisibility: style.contentVisibility,
            opacity: style.opacity, transform: style.transform.slice(0, 128), transformTruncated: style.transform.length > 128,
          };
        };
        // A hidden embedding iframe can suppress animations while the child
        // document still reports visible. Keep these reads failure-only too.
        const captureEmbedding = () => {
          const embedded = window.parent !== window;
          const ancestors: ReturnType<typeof captureAncestor>[] = [];
          try {
            let element = window.frameElement;
            const accessible = !embedded || element !== null;
            const view = element?.ownerDocument.defaultView;
            const document = view ? captureDocument(view) : null;
            while (element && ancestors.length < 8) {
              ancestors.push(captureAncestor(element));
              element = element.parentElement;
            }
            return { embedded, accessible, document, ancestors, truncated: element !== null, captureFailed: false };
          } catch {
            // An inaccessible embedding must not suppress the layer receipt.
            return { embedded, ancestors, captureFailed: true };
          }
        };
        const allFrames = frames(canvasElement);
        console.error("Ghost handoff failure: " + JSON.stringify({
          sampledAt, midFade: mid ?? null, framesAfterArrival: sampledFrame.clock.framesAfterArrival, sampled: { out, incoming },
          capturedAt: performance.now(),
          timeline: document.timeline.currentTime, theme: document.documentElement.dataset.theme,
          frameCount: allFrames.length, framesTruncated: allFrames.length > 2,
          frames: allFrames.slice(0, 2).map((frame) => {
            const layers = [...frame.querySelectorAll(".bk-ghost-out, .bk-ghost-in")];
            const handoff = handoffs.find((h) => h.frame === frame)?.clock;
            return {
              width: frame.parentElement?.getAttribute("data-width"),
              arrived: handoff?.arrivedAt, removed: handoff?.removedAt,
              layerCount: layers.length, layersTruncated: layers.length > 32,
              layers: layers.slice(0, 32).map((el, index) => {
                const animations = el.getAnimations();
                return {
                  index,
                  classes: String(el.className).slice(0, 128), classesTruncated: String(el.className).length > 128,
                  opacity: opacity(el),
                  animationCount: animations.length, animationsTruncated: animations.length > 4,
                  animations: animations.slice(0, 4).map((a) => ({
                    name: String((a as CSSAnimation).animationName ?? "").slice(0, 128),
                    nameTruncated: String((a as CSSAnimation).animationName ?? "").length > 128,
                    startTime: a.startTime, currentTime: a.currentTime,
                    playState: a.playState, pending: a.pending, playbackRate: a.playbackRate,
                    duration: a.effect?.getComputedTiming().duration,
                  })),
                };
              }),
            };
          }),
          // Read embedding layout after retaining the existing layer snapshot.
          document: captureDocument(window), embedding: captureEmbedding(),
        }));
      } catch { /* Keep the original assertion authoritative if capture fails. */ }
      throw error;
    }

    for (const [i, busy] of arrivedBusy.entries()) {
      await expect(busy).toBeNull();
      // Same box loading and ready: the line count matched, and nothing moved.
      await expect(Math.abs(arrivedRects[i]!.height - ghostRects[i]!.height)).toBeLessThanOrEqual(1);
      await expect(Math.abs(arrivedRects[i]!.top - ghostRects[i]!.top)).toBeLessThanOrEqual(1);
      await expect(Math.abs(arrivedRects[i]!.height - ready[i]!.height)).toBeLessThanOrEqual(1);
    }
    for (const [i, top] of arrivedAfter.entries()) await expect(Math.abs(top - ghostAfter[i]!)).toBeLessThanOrEqual(1);

    await Promise.all(handoffs.map(h => h.clock.settled));
    // Both widths must have entered and completed the real handoff. A missing
    // observation cannot turn into a zero-duration success.
    for (const { frame, clock } of handoffs) {
      clock.observe();
      const width = frame.parentElement?.getAttribute("data-width");
      await expect(clock.arrived, `${width}px: arriving layers committed over the ghost`).toBe(true);
      await expect(clock.fadeMs, `${width}px: the outgoing ghost's fade, in animation time`).toBeLessThanOrEqual(FADE_MS);
      await expect(clock.framesAfterFade, `${width}px: frames rendered with the ghost after its fade ended`).toBeLessThanOrEqual(FRAMES_AFTER_FADE);
      await expect(clock.removed, `${width}px: the outgoing ghost was removed`).toBe(true);
    }
    await expect(canvasElement.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);
  } finally {
    for (const h of handoffs) h.clock.dispose();
  }
}
