/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import type { CDPSession } from "playwright";

const sessions = new WeakMap<object, { session: CDPSession; active: boolean }>();
/** Chromium's input stack, including native capture and touch-action. */
export const rankTouch: BrowserCommand<["touchStart" | "touchMove" | "touchEnd" | "touchCancel", { x: number; y: number; id?: number }[]]> = async (ctx, type, points) => {
  let state = sessions.get(ctx.page);
  if (!state) {
    state = { session: await ctx.page.context().newCDPSession(ctx.page), active: false };
    sessions.set(ctx.page, state);
  }
  if (type === "touchCancel" && !state.active) return;
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error("Ranking test frame has no painted bounds");
  const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Vitest scales its iframe when a portrait viewport is taller than the host.
  const scaleX = bounds.width / viewport.width;
  const scaleY = bounds.height / viewport.height;
  await state.session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map(({ x, y, id = 0 }) => ({ x: x * scaleX + bounds.x, y: y * scaleY + bounds.y, id, radiusX: 2, radiusY: 2 })),
  });
  state.active = type !== "touchEnd" && type !== "touchCancel";
};
