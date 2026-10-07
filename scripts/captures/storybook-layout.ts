import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { awaitFonts, capturePage } from "./browser.ts";
import type { Catalogue } from "./catalogue.ts";

/** Measure the built preview: Vitest's story canvas does not reproduce its
 * centered, shrink-to-fit containing block (#1121). No CSS is injected here. */
export async function checkStorybookLayout(browser: Browser, root: string, cache: string, catalogue: Catalogue, origin: string): Promise<void> {
  const cases = [
    { id: "chrome-sessionstrip--overflow", max: 390, selector: "[data-composer-row]" },
    { id: "chrome-sessionstrip--wide", max: 720, selector: "[data-composer-row]" },
    { id: "chrome-modelpicker--default", max: 390, selector: "[data-model]" },
    { id: "conversation-turnerrorcard--default", max: 320 },
    { id: "primitives-meter--default", max: 360 },
    { id: "primitives-meter--wide", max: Infinity },
    { id: "primitives-chip--default", max: 360, inline: true },
  ];
  for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
    const { page, context, faults } = await capturePage(browser, root, cache, catalogue, [origin], { width, height: 900 }, theme);
    try {
      for (const scene of cases) {
        faults.length = 0;
        await page.goto(`${origin}/iframe.html?id=${scene.id}&viewMode=story&globals=theme:${theme}&embed=true`);
        await page.waitForFunction(() => (window as unknown as { __STORYBOOK_PREVIEW__?: { storyRenders?: Array<{ phase: string }> } }).__STORYBOOK_PREVIEW__?.storyRenders?.[0]?.phase === "finished");
        await awaitFonts(page, catalogue);
        const geometry = await page.evaluate(({ selector }) => {
          const canvas = document.querySelector<HTMLElement>("#storybook-root")!;
          const stage = canvas.firstElementChild as HTMLElement;
          const component = stage.firstElementChild as HTMLElement;
          const s = getComputedStyle(canvas);
          const control = selector ? stage.querySelector<HTMLElement>(selector) : null;
          return {
            available: canvas.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
            stage: stage.getBoundingClientRect().width,
            component: component.getBoundingClientRect().width,
            control: control?.getBoundingClientRect().width,
          };
        }, { selector: scene.selector });
        const name = `${scene.id} ${theme} ${width}px`;
        assert.ok(geometry.available >= width - 40, `${name}: centered preview must provide the viewport width: ${JSON.stringify(geometry)}`);
        assert.ok(Math.abs(geometry.stage - Math.min(scene.max, geometry.available)) < 1, `${name}: stage must use its intended available width: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.component > 100, `${name}: component must not collapse: ${JSON.stringify(geometry)}`);
        if (scene.selector) assert.ok((geometry.control ?? 0) > 10, `${name}: actual control must have width`);
        if (scene.inline) assert.ok(geometry.component < geometry.stage - 20, `${name}: inline chip must retain its intrinsic width`);
        assert.deepEqual(faults, [], `${name}: browser errors`);
        console.log(`Built Storybook layout: ${name} ${JSON.stringify(geometry)}`);
      }
    } finally { await context.close(); }
  }
}
