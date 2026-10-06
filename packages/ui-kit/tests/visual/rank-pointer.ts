/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import type { CDPSession } from "playwright";

const sessions = new WeakMap<object, { session: CDPSession; active: boolean }>();
/** Chromium's input stack, including native capture and touch-action. */
type Ctx = Parameters<BrowserCommand<[]>>[0];
async function touchState(ctx: Ctx) {
  let state = sessions.get(ctx.page);
  if (!state) {
    state = { session: await ctx.page.context().newCDPSession(ctx.page), active: false };
    sessions.set(ctx.page, state);
  }
  return state;
}
/** Maps a frame point to the page: Vitest scales its iframe when a portrait viewport is taller than the host. */
async function framePoint(ctx: Ctx) {
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error("Ranking test frame has no painted bounds");
  const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const scaleX = bounds.width / viewport.width;
  const scaleY = bounds.height / viewport.height;
  return ({ x, y, id = 0 }: { x: number; y: number; id?: number }) => ({ x: x * scaleX + bounds.x, y: y * scaleY + bounds.y, id, radiusX: 2, radiusY: 2 });
}
export const rankTouch: BrowserCommand<["touchStart" | "touchMove" | "touchEnd" | "touchCancel", { x: number; y: number; id?: number }[]]> = async (ctx, type, points) => {
  const state = await touchState(ctx);
  if (type === "touchCancel" && !state.active) return;
  const map = await framePoint(ctx);
  await state.session.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(map) });
  state.active = type !== "touchEnd" && type !== "touchCancel";
};
/**
 * One native tap: the same touchStart and touchEnd as two `rankTouch` calls,
 * in one command. Each dispatch still waits for the renderer to handle it;
 * only the browser round trips and the frame measurement are shared.
 */
export const rankTap: BrowserCommand<[{ x: number; y: number }]> = async (ctx, point) => {
  const state = await touchState(ctx);
  const map = await framePoint(ctx);
  state.active = true;
  await state.session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [map(point)] });
  await state.session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  state.active = false;
};

declare module "vitest/browser" {
  interface BrowserCommands {
    rankTap(point: { x: number; y: number }): Promise<void>;
  }
}
