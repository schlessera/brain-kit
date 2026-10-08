import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { CAPTURE_BROWSER_ARGUMENTS, launchCaptureBrowser, inspectPng } from "./browser.ts";
import { readCatalogue } from "./catalogue.ts";
import { captureRuntime } from "./runtime.ts";
import { compareCaptures } from "./verify.ts";
import { sha256 } from "./provenance.ts";

// This runs in the same pinned, network-denied container as editorial captures.
// Exercise the actual mounted app and approval executor, not a copied link demo.
const root = "/repo", output = "/captures", cache = "/fonts";
const catalogue = await readCatalogue(root);
const recipe = catalogue.harness_requirements.find((entry) => entry.id === "approval-roundtrip")!;
const observations: unknown[] = [];
for (const history of ["first", "second"] as const) {
  const browser = await launchCaptureBrowser();
  await writeFile(resolve(output, `browser-${history}.json`), JSON.stringify({ version: browser.version(),
    executable_sha256: sha256(await readFile(chromium.executablePath())), arguments: CAPTURE_BROWSER_ARGUMENTS,
    node: process.version, platform: process.platform, architecture: process.arch }, null, 2) + "\n");
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      let triggered = false;
      page.waitForFunction = new Proxy(page.waitForFunction, {
        async apply(target, receiver, args) {
          const result = await Reflect.apply(target, receiver, args);
          if (!triggered && await page.locator(".brain-file-link").count()) {
            triggered = true;
            if (history === "second") {
              // Headless rAF alone need not rasterize the initial fragments.
              // Preserve that actual native paint before invalidating them.
              await page.screenshot({ path: resolve(output, `prior-paint-${observations.length}.png`), animations: "disabled" });
              // Controlled prior paint history. Restore the exact style attribute
              // before captureRuntime's preparation/visibility/stability checks.
              await page.evaluate(async () => {
                const link = document.querySelector<HTMLElement>(".brain-file-link")!;
                const style = link.getAttribute("style");
                link.style.display = "inline-block";
                await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
                if (style === null) link.removeAttribute("style");
                else link.setAttribute("style", style);
                await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
              });
            }
          }
          return result;
        },
      });
      const screenshot = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        const bytes = await screenshot(options);
        const state = await page.evaluate(() => {
          const link = document.querySelector<HTMLElement>(".brain-file-link");
          if (!link) return null;
          const rect = link.getBoundingClientRect(), style = getComputedStyle(link);
          return { text: link.textContent, rect: [rect.x, rect.y, rect.width, rect.height],
            style: link.getAttribute("style"), font: style.font, color: style.color,
            decoration: style.textDecoration, display: style.display };
        });
        if (state) {
          const session = await context.newCDPSession(page);
          try {
            await session.send("DOM.enable"); await session.send("CSS.enable");
            const document = await session.send("DOM.getDocument");
            const { nodeId } = await session.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: ".brain-file-link" });
            const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
            if (!state.text || !fonts.some((font) => font.isCustomFont && font.familyName === "JetBrains Mono" && font.glyphCount > 0)) {
              throw new Error("Paint-history control lacks nonempty actual design-font glyphs");
            }
            observations.push({ history, sha256: inspectPng(bytes).sha256, state, fonts });
            await writeFile(resolve(output, "paint-observations.json"), JSON.stringify(observations, null, 2) + "\n");
          } finally { await session.detach(); }
        }
        return bytes;
      };
      return page;
    };
    return context;
  };
  try {
    const directory = resolve(output, history); await mkdir(directory, { recursive: true });
    const result = await captureRuntime(browser, root, cache, catalogue, recipe, directory);
    await writeFile(resolve(directory, "manifest.json"), JSON.stringify({ artifacts: [{ id: recipe.id, files: result.files, readiness: result.evidence }] }) + "\n");
  } finally { await browser.close(); }
}
const result = await compareCaptures(resolve(output, "first"), resolve(output, "second"));
await writeFile(resolve(output, "paint-reproducibility.json"), JSON.stringify(result, null, 2) + "\n");
console.log("Runtime captures agree across controlled native fragment paint histories", result);
