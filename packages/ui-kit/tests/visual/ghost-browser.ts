/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Chromium evaluates the real media queries: no matchMedia stub, no class. */
export const ghostMedia: BrowserCommand<["reduce" | "no-preference", "screen" | "print"]> = async (ctx, reducedMotion, media) => {
  await ctx.page.emulateMedia({ reducedMotion, media });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    ghostMedia(reducedMotion: "reduce" | "no-preference", media: "screen" | "print"): Promise<void>;
  }
}


/** Pixels from the real rendered frame, decoded in the browser test. */
export const ghostPixels: BrowserCommand<[string], string> = async (ctx, selector) => {
  return (await ctx.iframe.locator(selector).screenshot({ animations: "allow" })).toString("base64");
};

/** A finite steady-state trace of the exact 20-row/6-card story. */
export const ghostTrace: BrowserCommand<[], { paint: number; raster: number; browser: string }> = async (ctx) => {
  // Copy the real committed story into an isolated page. Vitest's own timer
  // and progress UI repaint while a command runs, and are not loading costs.
  const fixture = await ctx.iframe.locator("[data-ghost-performance]").evaluate((scene) => ({
    html: scene.outerHTML,
    theme: document.documentElement.dataset.theme,
    base: location.href,
    css: [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules].map((r) => r.cssText); } catch { return []; } }).join("\n"),
  }));
  const page = await ctx.page.context().newPage();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.setViewportSize({ width: 412, height: 915 });
  const session = await page.context().newCDPSession(page);
  const events: Record<string, unknown>[] = [];
  session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  try {
    await session.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: false });
    await page.setContent(`<html data-theme="${fixture.theme}"><head><base href="${fixture.base}"><style>${fixture.css}</style><style>body{margin:0;padding:16px;box-sizing:border-box;background:var(--bk-color-canvas)}</style></head><body>${fixture.html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await page.waitForTimeout(5200); // rasterise each swept region before steady state
    await session.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
    await page.waitForTimeout(3000);
    const complete = new Promise<void>((r) => session.once("Tracing.tracingComplete", () => r()));
    await session.send("Tracing.end");
    await complete;
    const msPerSecond = (name: string) => events.filter((e) => e.ph === "X" && e.name === name).reduce((n, e) => n + Number(e.dur ?? 0), 0) / 1000 / 3;
    const result = { paint: msPerSecond("Paint"), raster: msPerSecond("RasterTask"), browser: ctx.page.context().browser()!.version() };
    const directory = resolve(".vitest-attachments/ghost-sweep");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "trace.json"), JSON.stringify({ traceEvents: events.map(({ name, ph, dur, ...e }) => ({ name, ph, dur, ts: e.ts })) }));
    await writeFile(resolve(directory, "measurement.json"), JSON.stringify({ ...result, cpuThrottle: 6, viewport: { width: 412, height: 915, dpr: 2.625 }, windowSeconds: 3 }, null, 2));
    return result;
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
    await page.close();
  }
};

declare module "vitest/browser" {
  interface BrowserCommands {
    ghostPixels(selector: string): Promise<string>;
    ghostTrace(): Promise<{ paint: number; raster: number; browser: string }>;
  }
}

/** Paint the computed production mask without Vitest's overlay chrome. */
export const ghostMaskPixels: BrowserCommand<[string, number], string> = async (ctx, mask, width) => {
  const page = await ctx.page.context().newPage();
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setViewportSize({ width: Math.ceil(width) + 32, height: 80 });
    await page.setContent('<div id="probe" style="height:20px;background:black"><div style="width:100%;height:100%;background:white"></div></div>');
    await page.locator("#probe").evaluate((e, p) => { (e as HTMLElement).style.width = `${p.width}px`; (e.firstElementChild as HTMLElement).style.maskImage = p.mask; }, { mask, width });
    return (await page.locator("#probe").screenshot()).toString("base64");
  } finally { await page.close(); }
};
declare module "vitest/browser" {
  interface BrowserCommands { ghostMaskPixels(mask: string, width: number): Promise<string>; }
}
