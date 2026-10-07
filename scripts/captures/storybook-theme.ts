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
  for (const theme of ["dark", "light"] as const) for (const nested of ["light", "dark"] as const) {
    const id = `chrome-phoneframe--${nested === "light" ? "paper" : "dark"}`;
    const { page, context, faults } = await capturePage(browser, root, cache, catalogue, [origin], { width: 1280, height: 1000 }, theme);
    try {
      await page.goto(`${origin}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}&embed=true`);
      await page.waitForFunction(() => (window as unknown as { __STORYBOOK_PREVIEW__?: { storyRenders?: Array<{ phase: string }> } }).__STORYBOOK_PREVIEW__?.storyRenders?.[0]?.phase === "finished");
      await awaitFonts(page, catalogue);
      const colors = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>("#storybook-root > div")!;
        const row = frame.querySelector<HTMLElement>(".bk-screen-body > div")!;
        const input = frame.querySelector<HTMLTextAreaElement>("textarea")!;
        return { document: getComputedStyle(document.documentElement).colorScheme, scheme: getComputedStyle(frame).colorScheme, ink: getComputedStyle(frame).color, canvas: getComputedStyle(frame).backgroundColor, rowInk: getComputedStyle(row).color, surface: getComputedStyle(row).backgroundColor, controlScheme: getComputedStyle(input).colorScheme };
      });
      const name = `${id} inside ${theme}`;
      assert.equal(colors.document, theme, `${name}: outer document theme`);
      assert.equal(colors.ink, palettes[nested].ink, `${name}: nested ink must resolve in its own theme`);
      assert.equal(colors.canvas, palettes[nested].canvas, `${name}: nested canvas`);
      assert.equal(colors.rowInk, palettes[nested].ink, `${name}: descendant ink`);
      assert.equal(colors.surface, palettes[nested].surface, `${name}: descendant surface`);
      assert.equal(colors.scheme, nested, `${name}: frame color scheme`);
      assert.equal(colors.controlScheme, nested, `${name}: native control color scheme`);
      assert.deepEqual(faults, [], `${name}: browser errors`);
      console.log(`Built Storybook theme: ${name} ${JSON.stringify(colors)}`);
    } finally { await context.close(); }
  }
}
