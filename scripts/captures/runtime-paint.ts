import type { Page } from "playwright";

/** Rebuild inline fragments before editorial capture, preserving final app state. */
export async function refreshRuntimeLinkPaint(page: Page): Promise<void> {
  if (!await page.locator(".brain-file-link").count()) return;
  // A headless animation frame does not guarantee an initial surface raster.
  // Materialize it before rebuilding fragments; this frame is never accepted.
  await page.screenshot({ animations: "disabled" });
  const preparation = await page.evaluateHandle(() => {
    const links = [...document.querySelectorAll<HTMLElement>(".brain-file-link")];
    if (!links.length) throw new Error("Runtime links disappeared before preparation");
    const measure = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return JSON.stringify({ rect: [rect.x, rect.y, rect.width, rect.height], text: element.textContent,
        font: style.font, color: style.color, decoration: style.textDecoration,
        display: style.display, transform: style.transform, opacity: style.opacity });
    };
    const originals = links.map((element) => ({ element, style: element.getAttribute("style"), state: measure(element) }));
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    return { originals, measure, frame };
  });
  try {
    await preparation.evaluate(async ({ originals, frame }) => {
      for (const { element } of originals) element.style.display = getComputedStyle(element).display === "inline-block" ? "inline" : "inline-block";
      await frame();
    });
    // Materialize the temporary fragment tree too. Headless animation frames
    // alone provide no receipt that this temporary state was painted.
    await page.screenshot({ animations: "disabled" });
  } finally {
    try {
      await preparation.evaluate(async ({ originals, measure, frame }) => {
        for (const { element, style } of originals) {
          if (style === null) element.removeAttribute("style");
          else element.setAttribute("style", style);
        }
        await frame();
        if (originals.some(({ element, state }) => !element.isConnected || measure(element) !== state)) {
          throw new Error("Runtime link repaint changed final content, style or geometry");
        }
      });
    } finally { await preparation.dispose(); }
  }
}
