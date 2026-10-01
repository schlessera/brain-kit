/** Test-only observation of the real bin's default Puppeteer launch and pages. */
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export interface GeoRenderReceipt {
  launchArgs: string[][];
  inlineImages: string[];
  otherRequests: string[];
}

const receipt: GeoRenderReceipt = { launchArgs: [], inlineImages: [], otherRequests: [] };
const path = process.env.GEO_RENDER_TEST_RECEIPT;
if (!path) throw new Error("The geo render observer requires a test-owned receipt path.");
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async options => {
  receipt.launchArgs.push(options?.args ?? []);
  const browser = await launch(options);
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await newPage();
    // Attach before the renderer receives the page, so the first inline request is observed.
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith("data:image/png;base64,")) {
        receipt.inlineImages.push(createHash("sha256").update(Buffer.from(url.split(",", 2)[1]!, "base64")).digest("hex"));
      } else if (!url.startsWith("data:") && url !== "about:blank") receipt.otherRequests.push(url);
    });
    return page;
  };
  return browser;
};
process.on("exit", () => writeFileSync(path, JSON.stringify(receipt)));
