import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { REFERENCE_DATE, REFERENCE_INSTANT } from "../../packages/ui-kit/fixtures/time.ts";
import type { Catalogue, StillRecipe, Viewport } from "./catalogue.ts";
import { verifyFontCache } from "./fonts.ts";
import { sha256 } from "./provenance.ts";

type Clip = { x: number; y: number; width: number; height: number };

// Measured runtime reloads otherwise varied at rounded-border raster edges.
// Keep this editorial setting explicit; regression rendering stays unchanged.
export const CAPTURE_BROWSER_ARGUMENTS = ["--disable-partial-raster"];

export async function startStaticServer(directory: string): Promise<{ origin: string; close(): Promise<void> }> {
  const root = resolve(directory);
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
      const bytes = await readFile(path);
      response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local capture server address");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())) };
}

export async function launchCaptureBrowser(): Promise<Browser> {
  if (!chromium.executablePath().startsWith("/ms-playwright/")) {
    throw new Error("Feature capture must run in the shared browser image, not a host Chromium");
  }
  return chromium.launch({ headless: true, args: CAPTURE_BROWSER_ARGUMENTS });
}

export async function capturePage(
  browser: Browser, root: string, cache: string, catalogue: Catalogue,
  origins: string[], viewport: Viewport, theme: "dark" | "light",
): Promise<{ context: BrowserContext; page: Page; faults: string[] }> {
  const fonts = await verifyFontCache(root, cache);
  const context = await browser.newContext({
    viewport, deviceScaleFactor: catalogue.environment.device_scale_factor,
    locale: catalogue.environment.locale, timezoneId: catalogue.environment.timezone,
    reducedMotion: catalogue.environment.reduced_motion, colorScheme: theme,
  });
  const faults: string[] = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === fonts.lock.preview_stylesheet_url) return route.fulfill({ body: Buffer.from(fonts.css), contentType: "text/css" });
    const asset = fonts.lock.assets.find((entry) => entry.url === url);
    if (asset) return route.fulfill({ body: Buffer.from(fonts.files.get(url)!), contentType: asset.content_type });
    if (url.startsWith("data:") || url.startsWith("blob:") || origins.includes(new URL(url).origin)) return route.continue();
    faults.push(`Unexpected external request: ${url}`);
    return route.abort();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const origin = new URL(socket.url()).origin.replace(/^ws/, "http");
    if (origins.includes(origin)) { socket.connectToServer(); return; }
    faults.push(`Unexpected external WebSocket: ${socket.url()}`);
    socket.close({ code: 1008, reason: "Capture permits local fixture sockets only" });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => faults.push(`Browser error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") faults.push(`Console error: ${message.text()}`); });
  await page.clock.setFixedTime(REFERENCE_INSTANT);
  await page.addInitScript(() => {
    let seed = 0x0d19;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  });
  return { context, page, faults };
}

/** Storybook's verified render lifecycle finishes after play and afterEach. */
export async function awaitStory(page: Page, origin: string, storyId: string, theme: "dark" | "light"): Promise<void> {
  await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story&globals=theme:${theme}`, { waitUntil: "load" });
  await page.waitForFunction((id) => {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: { storyRenders?: Array<{ id: string; phase: string }> } }).__STORYBOOK_PREVIEW__;
    return preview?.storyRenders?.some((render) => render.id === id && render.phase === "finished");
  }, storyId, { timeout: 20_000 });
  const result = await page.evaluate((id) => {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__: { channel: { last(name: string): Array<{ storyId: string; status: string }> } } }).__STORYBOOK_PREVIEW__;
    const event = preview.channel.last("storyFinished")[0];
    return event?.storyId === id ? event.status : "missing";
  }, storyId);
  if (result !== "success") throw new Error(`${storyId}: render/play did not finish successfully (${result})`);
}

export async function awaitFonts(page: Page, catalogue: Catalogue): Promise<Array<{request:string;family:string;weight:string;style:string;status:string}>> {
  const faces = Object.entries(catalogue.environment.font_families).flatMap(([family, weights]) => weights.map((weight) => {
    const [number, style] = weight.split(" ");
    return `${style === "italic" ? "italic " : ""}${number} 16px "${family}"`;
  }));
  return page.evaluate(async (required) => {
    const observed: Array<{request:string;family:string;weight:string;style:string;status:string}> = [];
    for (const face of required) {
      const loaded = await document.fonts.load(face, "Odysseus");
      const weight = /\b(\d+) 16px/.exec(face)?.[1], style=face.startsWith("italic ")?"italic":"normal";
      if (!loaded.length || loaded.some((font) => font.status !== "loaded" || font.weight!==weight || font.style!==style)) throw new Error(`Required font face failed: ${face}`);
      for (const font of loaded) observed.push({request:face,family:font.family,weight:font.weight,style:font.style,status:font.status});
    }
    await document.fonts.ready;
    if (!required.every((face) => document.fonts.check(face, "Odysseus"))) throw new Error("Required preview faces are unavailable");
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    return observed;
  }, faces);
}

/** Match actual text ranges and their clipping ancestors, including scrolling bodies. */
export async function visibleText(page: Page, selector: string, required: string[], clip: Clip, caseSensitive: boolean): Promise<string[]> {
  return page.evaluate(({ selector, required, clip, caseSensitive }) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`Capture root is missing: ${selector}`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const positions: Array<{ node: Node; offset: number }> = [];
    let text = "";
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName ?? "")) continue;
      const value = node.textContent ?? "";
      for (let offset = 0; offset < value.length; offset++) {
        const char = value[offset];
        if (/\s/.test(char)) {
          if (!text.endsWith(" ")) { text += " "; positions.push({ node, offset }); }
        } else {
          const normalized = caseSensitive ? char : char.toLowerCase();
          for (const part of normalized) { text += part; positions.push({ node, offset }); }
        }
      }
    }
    return required.filter((label) => {
      const normalized = label.replace(/\s+/g, " ");
      const needle = caseSensitive ? normalized : normalized.toLowerCase();
      let at = text.indexOf(needle);
      while (at !== -1) {
        const start = positions[at], end = positions[at + needle.length - 1];
        const range = document.createRange();
        range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset + 1);
        let bounds = { left: clip.x, top: clip.y, right: clip.x + clip.width, bottom: clip.y + clip.height };
        let ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
        let hidden = false;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) hidden = true;
          const box = ancestor.getBoundingClientRect();
          if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
            bounds = { ...bounds, left: Math.max(bounds.left, box.left), right: Math.min(bounds.right, box.right) };
          }
          if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
            bounds = { ...bounds, top: Math.max(bounds.top, box.top), bottom: Math.min(bounds.bottom, box.bottom) };
          }
          ancestor = ancestor.parentElement;
        }
        const rects = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
        if (!hidden && rects.length && rects.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1)) return false;
        at = text.indexOf(needle, at + 1);
      }
      return true;
    });
  }, { selector, required, clip, caseSensitive });
}

/** Inspect the actual PNG pixels, not just its compressed byte count. */
export function inspectPng(bytes: Buffer): { width: number; height: number; distinct_sample_colors: number; sha256: string;pixels_sha256:string } {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Capture is not a PNG");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  if (!width || !height || bytes[24] !== 8 || !channels || bytes[28] !== 0) throw new Error("Unsupported or empty capture PNG");
  const compressed: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "IDAT") compressed.push(bytes.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const data = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  if (data.length !== height * (stride + 1)) throw new Error("Truncated capture PNG");
  let previous = Buffer.alloc(stride);
  const colors = new Set<number>();
  const pixels = createHash("sha256");
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0, above = previous[x], upperLeft = x >= channels ? previous[x - channels] : 0;
      const p = left + above - upperLeft;
      const distances = [Math.abs(p - left), Math.abs(p - above), Math.abs(p - upperLeft)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : upperLeft;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth : NaN;
      if (Number.isNaN(predictor)) throw new Error("Invalid capture PNG filter");
      row[x] = (data[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
    if(colors.size<32)for (let x = 0; x < stride && colors.size<32; x += channels) colors.add((row[x] << 16) | (row[x + 1] << 8) | row[x + 2]);
    pixels.update(row);
    previous = row;
  }
  if (colors.size < 8) throw new Error("Blank or insufficiently painted capture");
  return { width, height, distinct_sample_colors: colors.size, sha256: sha256(bytes),pixels_sha256:pixels.digest("hex") };
}

export async function captureStill(
  browser: Browser, root: string, cache: string, catalogue: Catalogue, origin: string,
  recipe: StillRecipe, theme: "dark" | "light" = recipe.theme, viewport?: Viewport,
): Promise<{ bytes: Buffer; evidence: Record<string, unknown> }> {
  const profile = catalogue.profiles[recipe.profile];
  const { context, page, faults } = await capturePage(browser, root, cache, catalogue, [origin], viewport ?? profile.viewport, theme);
  try {
    await awaitStory(page, origin, recipe.source.story_id, theme);
    const loaded = await awaitFonts(page, catalogue);
    const state = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme,
      scroll: [...document.querySelectorAll(".bk-screen-body")].map((element) => element.scrollTop),
      images_ready: [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    }));
    if (state.theme !== theme || state.scheme !== theme || !state.images_ready || state.scroll.some((top) => top !== 0)) throw new Error("Theme, image or initial-scroll readiness failed");
    const element = await page.locator(profile.crop.selector).first().boundingBox();
    const dimensionsMatch = element && (profile.crop.inset_px > 0
      ? Math.abs(element.width - profile.crop.expected_element.width) <= 0.01 && Math.abs(element.height - profile.crop.expected_element.height) <= 0.01
      : Math.round(element.width) === profile.crop.expected_element.width && Math.round(element.height) === profile.crop.expected_element.height);
    if (!element || !dimensionsMatch) throw new Error(`Source crop geometry differs from its declared profile: expected ${JSON.stringify(profile.crop.expected_element)}, observed ${JSON.stringify(element)}`);
    const clip = { x: element.x + profile.crop.inset_px, y: element.y + profile.crop.inset_px, ...profile.crop.output };
    const missing = await visibleText(page, "#storybook-root", recipe.readiness.required_visible_text, clip, recipe.readiness.text_case_sensitive);
    if (missing.length) throw new Error(`Required text is absent or outside the crop: ${missing.join(", ")}`);
    const bytes = await page.screenshot({ clip, animations: "disabled" });
    if (faults.length) throw new Error(faults.join("; "));
    const pixels = inspectPng(bytes);
    if (pixels.width !== clip.width || pixels.height !== clip.height) throw new Error("Actual PNG dimensions differ from the crop");
    return { bytes, evidence: { ...pixels, ...state, fonts: loaded, required_visible_text: recipe.readiness.required_visible_text, clip, story_render: "finished:success", reference_date: REFERENCE_DATE, reference_instant: REFERENCE_INSTANT, random_seed: 0x0d19 } };
  } catch (error) { throw new Error(`${recipe.id}: ${(error as Error).message}${faults.length ? "; " + faults.join("; ") : ""}`); }
  finally { await context.close(); }
}
