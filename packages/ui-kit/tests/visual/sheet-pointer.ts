/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import type { CDPSession } from "playwright";
const sessions = new WeakMap<object, { cdp: CDPSession; epoch: number; active: "touch" | "pen" | "mouse" | null }>();
type Input = { type: "down" | "move" | "up" | "cancel"; x: number; y: number; t: number; second?: boolean };
/** Native Chromium input, with explicit event times to measure the 80ms window. */
export const sheetInput: BrowserCommand<["touch" | "pen" | "mouse", Input[]]> = async (ctx, pointer, inputs) => {
  let state = sessions.get(ctx.page);
  if (!state) { state = { cdp: await ctx.page.context().newCDPSession(ctx.page), epoch: 0, active: null }; sessions.set(ctx.page, state); }
  const frame = await ctx.frame();
  const bounds = await (await frame.frameElement()).boundingBox();
  if (!bounds) throw new Error("Sheet frame has no bounds");
  const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (const input of inputs) {
    if ((input.type === "up" || input.type === "cancel") && state.active !== pointer) continue;
    if (input.type === "down") state.active = pointer;
    if (input.type === "down" && !input.second) state.epoch = Date.now() / 1000;
    const x = bounds.x + input.x * bounds.width / viewport.width;
    const y = bounds.y + input.y * bounds.height / viewport.height;
    const timestamp = state.epoch + input.t / 1000;
    if (pointer === "touch") {
      const points = input.type === "up" || input.type === "cancel" ? [] : [{ x, y, id: 1, radiusX: 2, radiusY: 2 }, ...(input.second ? [{ x: x + 20, y, id: 2, radiusX: 2, radiusY: 2 }] : [])];
      await state.cdp.send("Input.dispatchTouchEvent", { type: input.type === "down" ? "touchStart" : input.type === "move" ? "touchMove" : input.type === "up" ? "touchEnd" : "touchCancel", touchPoints: points, timestamp });
    } else {
      await state.cdp.send("Input.dispatchMouseEvent", { type: input.type === "down" ? "mousePressed" : input.type === "move" ? "mouseMoved" : "mouseReleased", x, y, button: "left", buttons: input.type === "up" ? 0 : 1, clickCount: input.type === "move" ? 0 : 1, pointerType: pointer, timestamp });
    }
    if (input.type === "up" || input.type === "cancel") state.active = null;
  }
};
declare module "vitest/browser" {
  interface BrowserCommands { sheetInput(pointer: "touch" | "pen" | "mouse", inputs: Input[]): Promise<void>; }
}
