import type { Page } from "playwright";

/** Rebuild inline fragments before editorial capture, preserving final app state. */
export async function refreshRuntimeLinkPaint(page: Page): Promise<void> {
  if (!await page.locator(".brain-file-link").count()) return;
  // A headless animation frame does not guarantee an initial surface raster.
  // Materialize it before rebuilding fragments; this frame is never accepted.
  await page.screenshot({ animations: "disabled" });
  await page.evaluate(async () => {
    const links = [...document.querySelectorAll<HTMLElement>(".brain-file-link")];
    if (!links.length) return;
    const measure = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return JSON.stringify({ rect: [rect.x, rect.y, rect.width, rect.height], text: element.textContent,
        font: style.font, color: style.color, decoration: style.textDecoration,
        display: style.display, transform: style.transform, opacity: style.opacity });
    };
    const originals = links.map((element) => ({ element, style: element.getAttribute("style"), state: measure(element) }));
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    // Chromium can retain either of two dotted-decoration rasters at identical
    // final style/geometry (#1284). Rebuild the fragments through the same path
    // before measuring stability; waiting for identical frames alone retains
    // whichever raster that page's earlier paint history selected.
    try {
      for (const { element } of originals) element.style.display = getComputedStyle(element).display === "inline-block" ? "inline" : "inline-block";
      await frame();
    } finally {
      for (const { element, style } of originals) {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }
    }
    await frame();
    if (originals.some(({ element, state }) => !element.isConnected || measure(element) !== state)) {
      throw new Error("Runtime link repaint changed final content, style or geometry");
    }
  });
}
