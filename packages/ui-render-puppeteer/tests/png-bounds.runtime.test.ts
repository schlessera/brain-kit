/** Actual PNG output proof for degenerate layouts; fixtures never load assets. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page, type ScreenshotOptions } from "puppeteer-core";
import { createRenderer } from "../src/renderer";

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(path => path && existsSync(path));
if (!chromePath && process.env.BRAIN_REQUIRE_CHROME === "1") {
  throw new Error("BRAIN_REQUIRE_CHROME=1, but no Chrome/Chromium executable was found for PNG bounds proof");
}
if (!chromePath) console.warn("SKIPPING PNG bounds runtime proof: no Chrome/Chromium found");

const browsers: Browser[] = [];
const exits: Promise<void>[] = [];
const requests: string[] = [];
let captures = 0;
let captureBoundary: "body" | "fallback" | undefined;

async function checkPolicyCapture(page: Page, options: ScreenshotOptions) {
  const body = await (await page.$("body"))!.boundingBox();
  if (captureBoundary === "fallback") {
    // A real zero body reaches document/viewport geometry, despite overflow.
    expect(body?.width).toBe(0);
    expect(body?.height).toBe(0);
    return;
  }
  expect(body!.width).toBeGreaterThanOrEqual(1);
  expect(body!.height).toBeGreaterThanOrEqual(1);
  const disclosure = await page.evaluate(() => {
    const anchor = document.querySelector<HTMLAnchorElement>("a[data-brain-export-link]")!;
    const destination = anchor.querySelector<HTMLElement>("[data-brain-link-destination]")!;
    const range = document.createRange();
    const walker = document.createTreeWalker(destination, NodeFilter.SHOW_TEXT);
    const glyphs: Array<{ width: number; height: number; x: number; y: number; right: number; bottom: number; painted: boolean }> = [];
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text.data[i])) continue;
        range.setStart(text, i); range.setEnd(text, i + 1);
        const rect = range.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        glyphs.push({ width: rect.width, height: rect.height, x: rect.x, y: rect.y,
          right: rect.right, bottom: rect.bottom, painted: !!top && destination.contains(top) });
      }
    }
    return { text: destination.textContent, opacity: getComputedStyle(destination).opacity,
      visibility: getComputedStyle(destination).visibility, glyphs };
  });
  expect(disclosure.text).toBe(" (example.org)");
  // Geometry alone cannot observe opacity: this specifically requires the
  // browser finishing step to repair the fixture's hidden destination.
  expect(disclosure.opacity).toBe("1");
  expect(disclosure.visibility).toBe("visible");
  expect(disclosure.glyphs.length).toBeGreaterThan(0);
  const clip = options.clip!;
  for (const glyph of disclosure.glyphs) {
    expect(glyph.width).toBeGreaterThan(0);
    expect(glyph.height).toBeGreaterThan(0);
    expect(glyph.painted).toBe(true);
    expect(glyph.x).toBeGreaterThanOrEqual(clip.x);
    expect(glyph.y).toBeGreaterThanOrEqual(clip.y);
    expect(glyph.right).toBeLessThanOrEqual(clip.x + clip.width);
    expect(glyph.bottom).toBeLessThanOrEqual(clip.y + clip.height);
  }
}
const r = createRenderer({
  executablePath: chromePath,
  launch: async options => {
    // Preserve the actual renderer launch arguments and sandbox.
    expect(options.args).not.toContain("--no-sandbox");
    const browser = await puppeteer.launch(options);
    browsers.push(browser);
    const child = browser.process()!;
    exits.push(new Promise(resolve => child.once("exit", () => resolve())));
    console.log(`[png-bounds] ${await browser.version()}; Bun ${Bun.version}`);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      await page.setOfflineMode(true);
      page.on("request", request => requests.push(request.url()));
      const screenshot = page.screenshot.bind(page);
      page.screenshot = (async (options: ScreenshotOptions) => {
        if (captureBoundary) await checkPolicyCapture(page, options);
        captures++;
        return screenshot(options);
      }) as typeof page.screenshot;
      return page;
    };
    return browser;
  },
});
afterAll(async () => {
  await r.shutdown();
  for (const browser of browsers) expect(browser.connected).toBe(false);
  // Assert owned native processes exited, rather than only losing CDP handles.
  await Promise.all(exits);
  expect(requests).toEqual([]);
  console.log(`[png-bounds] ${captures} actual PNG captures`);
}, 10_000);

function dimensions(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.subarray(12, 16).toString()).toBe("IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(width).toBeLessThanOrEqual(4096);
  expect(height).toBeLessThanOrEqual(16_384);
  return [width, height];
}

const htmlDocument = (style: string, content = "") =>
  `<!doctype html><html><head><style>html,body{margin:0;padding:0}${style}</style></head><body>${content}</body></html>`;

describe.skipIf(!chromePath)("PNG bounds in real offline Chromium", () => {
  // Every distinct native geometry remains on the direct HTML path.
  test(`direct: zero body with 2200 by 1100 positioned overflow obeys PNG width cap`, async () => {
    const png = await r.renderPng({ html: htmlDocument(
      "html,body{width:0;height:0}div{position:absolute;left:0;top:0;width:2200px;height:1100px;background:#123456}",
      "<div>Odysseus</div>",
    ) });
    expect(dimensions(png)).toEqual([4096, 2200]);
  }, 90_000);
  test(`direct: zero body with 330 by 8300 positioned overflow obeys PNG height cap`, async () => {
    const png = await r.renderPng({ html: htmlDocument(
      "html,body{width:0;height:0}div{position:absolute;left:0;top:0;width:330px;height:8300px;background:#123456}",
      "<div>Odysseus</div>",
    ) });
    expect(dimensions(png)).toEqual([1536, 16_384]);
  }, 90_000);
  for (const [name, style, content, expected] of [
    ["ordinary flow", "div{height:100px}", "<div>Odysseus</div>", [1536, 200]],
    ["explicit body", "body{width:400px;height:200px}", "Odysseus", [800, 400]],
    ["empty body", "html,body{width:0;height:0}", "", [1536, 2048]],
    ["fixed-only body", "html,body{width:0;height:0}div{position:fixed;left:0;top:0;width:100px;height:100px;background:#123456}", "<div>Odysseus</div>", [1536, 2048]],
    ["wide normal flow", "body{width:2200px;height:100px}", "Odysseus", [4096, 200]],
    ["tall normal flow", "body{width:330px;height:8300px}", "Odysseus", [660, 16_384]],
    ["null body box", "body{display:none}", "", [1536, 2048]],
    ["fractional body", "body{width:.5px;height:.5px}", "", [1536, 2048]],
  ] as const) {
    test(`direct: ${name} retains useful bounded capture`, async () => {
      expect(dimensions(await r.renderPng({ html: htmlDocument(style, content) }))).toEqual([...expected]);
    }, 90_000);
  }

  test("visible-destinations: body capture paints the protected destination", async () => {
    captureBoundary = "body";
    try {
      const png = await r.renderPng({ linkPolicy: "visible-destinations", html: htmlDocument(
        "body{width:400px;min-height:100px}[data-brain-link-destination]{opacity:0!important}",
        '<a href="https://example.org/ithaca">Odysseus</a>',
      ) });
      expect(dimensions(png)).toEqual([800, 200]);
    } finally {
      captureBoundary = undefined;
    }
  }, 90_000);

  test("visible-destinations: zero body overflow uses bounded fallback capture", async () => {
    captureBoundary = "fallback";
    try {
      const png = await r.renderPng({ linkPolicy: "visible-destinations", html: htmlDocument(
        "html,body{width:0;height:0}div{position:absolute;left:0;top:0;width:2200px;height:1100px;background:#123456}",
        "<div>Odysseus</div>",
      ) });
      expect(dimensions(png)).toEqual([4096, 2200]);
    } finally {
      captureBoundary = undefined;
    }
  }, 90_000);
});
