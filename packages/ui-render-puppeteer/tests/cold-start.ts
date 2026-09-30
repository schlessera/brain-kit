// Manual measurement: one launch in a fresh process/container; no remote assets.
import puppeteer from "puppeteer-core";
import { createRenderer } from "../src/renderer.js";

let launchMs = 0;
const start = performance.now();
const renderer = createRenderer({
  executablePath: process.argv[2],
  noSandbox: process.argv.includes("--no-sandbox"),
  browserTimeoutMs: 120_000,
  renderTimeoutMs: 120_000,
  launch: async (args) => {
    const launchStart = performance.now();
    const browser = await puppeteer.launch({ ...args, timeout: 120_000 });
    launchMs = performance.now() - launchStart;
    return browser;
  },
});
try {
  const png = await renderer.renderPng({ html: "<html><body><h1>cold start</h1></body></html>" });
  const totalMs = performance.now() - start;
  if (png.subarray(1, 4).toString() !== "PNG") throw new Error("No PNG produced");
  console.log(JSON.stringify({ launchMs: Math.round(launchMs), renderMs: Math.round(totalMs - launchMs), totalMs: Math.round(totalMs) }));
} finally {
  await renderer.shutdown();
}
