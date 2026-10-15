/** Real CDP receive boundary behind the PDF refusal assertions (#1999). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { expectAsyncRejection } from "./fixtures/async-rejection.ts";

const chromePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(path => path && existsSync(path));
if (!chromePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Chrome required for native rejection proof");

let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!chromePath) return;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: [
    "--no-sandbox", "--disable-setuid-sandbox", "--host-resolver-rules=MAP * ~NOTFOUND",
    "--block-new-web-contents", "--disable-dev-shm-usage", "--disable-gpu",
  ] });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", request => { void request.abort().catch(() => {}); });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!chromePath)("native asynchronous rejection", () => {
  test("a complete large response, rejection and subsequent page retain valid CDP delivery", async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      // This ordinary response reaches the native receive/microtask boundary.
      // No proxy, altered frames, dispatch patches or timing waits are involved.
      const response = await page.evaluate(() => "x".repeat(65_536));
      expect(response.length).toBe(65_536);
      const sentinel = new Error("Odysseus native command sentinel");
      await expectAsyncRejection((async () => {
        expect(await page.evaluate(() => 42)).toBe(42);
        throw sentinel;
      })(), sentinel.message);
      const next = await browser.newPage();
      try {
        expect(await next.evaluate(() => 43)).toBe(43);
      } finally {
        await next.close();
      }
    }
    expect(browser.connected).toBe(true);
  });
});
