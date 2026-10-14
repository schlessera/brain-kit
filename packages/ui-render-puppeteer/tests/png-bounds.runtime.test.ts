/** Actual PNG output proof for degenerate layouts; fixtures never load assets. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
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

const document = (style: string, content = "") =>
  `<!doctype html><html><head><style>html,body{margin:0;padding:0}${style}</style></head><body>${content}</body></html>`;

describe.skipIf(!chromePath)("PNG bounds in real offline Chromium", () => {
  // Exercise direct HTML and the enforced app-export policy path independently.
  for (const linkPolicy of [undefined, "visible-destinations"] as const) {
    const mode = linkPolicy ?? "direct";
    test(`${mode}: zero body with 2200 by 1100 positioned overflow obeys PNG width cap`, async () => {
      const png = await r.renderPng({ linkPolicy, html: document(
        "html,body{width:0;height:0}div{position:absolute;left:0;top:0;width:2200px;height:1100px;background:#123456}",
        "<div>Odysseus</div>",
      ) });
      expect(dimensions(png)).toEqual([4096, 2200]);
    }, 90_000);
    test(`${mode}: zero body with 330 by 8300 positioned overflow obeys PNG height cap`, async () => {
      const png = await r.renderPng({ linkPolicy, html: document(
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
      test(`${mode}: ${name} retains useful bounded capture`, async () => {
        expect(dimensions(await r.renderPng({ html: document(style, content), linkPolicy }))).toEqual([...expected]);
      }, 90_000);
    }
  }
});
