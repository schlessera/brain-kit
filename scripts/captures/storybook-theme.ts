import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { awaitFonts, capturePage } from "./browser.ts";
import type { Catalogue } from "./catalogue.ts";

/** D32 needs token evaluation at the using subtree. Check the minified static
 * artifact, which the development-only story runner never loads (#1122). */
export async function checkStorybookTheme(browser: Browser, root: string, cache: string, catalogue: Catalogue, origin: string): Promise<void> {
  const palettes = {
    light: { ink: "rgb(35, 31, 26)", canvas: "rgb(236, 231, 220)", surface: "rgb(248, 245, 239)" },
    dark: { ink: "rgb(232, 228, 223)", canvas: "rgb(12, 14, 18)", surface: "rgb(20, 22, 25)" },
  };
  for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) for (const nested of ["light", "dark", "inherit"] as const) {
    const expectedTheme = nested === "inherit" ? theme : nested;
    const id = nested === "inherit" ? "chrome-phoneframe--the-column-holds" : `chrome-phoneframe--${nested === "light" ? "paper" : "dark"}`;
    const { page, context, faults } = await capturePage(browser, root, cache, catalogue, [origin], { width, height: 1000 }, theme);
    try {
      await page.goto(`${origin}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}&embed=true`);
      await page.waitForFunction(() => (window as unknown as { __STORYBOOK_PREVIEW__?: { storyRenders?: Array<{ phase: string }> } }).__STORYBOOK_PREVIEW__?.storyRenders?.[0]?.phase === "finished");
      await awaitFonts(page, catalogue);
      const colors = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>("#storybook-root > div")!;
        const row = frame.querySelector<HTMLElement>(".bk-screen-body > div")!;
        const input = frame.querySelector<HTMLTextAreaElement>("textarea")!;
        return { left: frame.getBoundingClientRect().left, document: getComputedStyle(document.documentElement).colorScheme, scheme: getComputedStyle(frame).colorScheme, ink: getComputedStyle(frame).color, canvas: getComputedStyle(frame).backgroundColor, rowInk: getComputedStyle(row).color, surface: getComputedStyle(row).backgroundColor, controlScheme: getComputedStyle(input).colorScheme };
      });
      const name = `${id} inside ${theme} at ${width}px`;
      assert.ok(colors.left >= 0, `${name}: oversized frame must remain reachable from the left edge`);
      assert.equal(colors.document, theme, `${name}: outer document theme`);
      assert.equal(colors.ink, palettes[expectedTheme].ink, `${name}: nested ink must resolve in its own theme`);
      assert.equal(colors.canvas, palettes[expectedTheme].canvas, `${name}: nested canvas`);
      assert.equal(colors.rowInk, palettes[expectedTheme].ink, `${name}: descendant ink`);
      assert.equal(colors.surface, palettes[expectedTheme].surface, `${name}: descendant surface`);
      assert.equal(colors.scheme, expectedTheme, `${name}: frame color scheme`);
      assert.equal(colors.controlScheme, expectedTheme, `${name}: native control color scheme`);
      assert.deepEqual(faults, [], `${name}: browser errors`);
      console.log(`Built Storybook theme: ${name} ${JSON.stringify(colors)}`);
    } finally { await context.close(); }
  }
}
