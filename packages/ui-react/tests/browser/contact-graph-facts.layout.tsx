/** Exercise the actual GraphNodeRail caller's 72px ContactCard minimum (#599). */
import { afterEach, beforeAll, afterAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { GraphNodeRail } from "../../src/components/graph/graph-node-rail.js";

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let styles: HTMLStyleElement;
let viewport: { width: number; height: number };

beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = `${await commands.formConsumerStyles()}\n${await commands.rankFooterFonts()}`;
  document.head.append(styles);
  await document.fonts.load('500 10.5px "JetBrains Mono"');
  await document.fonts.ready;
});
afterAll(() => styles?.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  renderer = undefined;
  ui = undefined;
  host = undefined;
  await page.viewport(viewport.width, viewport.height);
});

for (const theme of ["dark", "light"]) {
  test(`${theme}: mounted graph rail keeps the fitting 72px fact geometry`, async () => {
    viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(900, 700);
    host = document.createElement("div");
    host.dataset.theme = theme;
    document.body.append(host);
    ui = createBrainUiRoot({ storage: null, request: async () => { throw new Error("graph control must stay keyless and offline"); } });
    ui.stores.graph.setState({
      selectedId: 1,
      subgraph: {
        nodes: [{ id: 1, path: "people/penelope.md", title: "Penelope", type: "person", inDegree: 2, outDegree: 3, distance: 1 }],
        edges: [], truncated: false,
      },
    });
    renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={ui}><GraphNodeRail /></BrainUiProvider>));
    const rail = host.querySelector<HTMLElement>('aside[aria-label="Selected node"]')!;
    expect(rail).not.toBeNull();
    expect(rail.getBoundingClientRect().width, "actual 340px consumer rail").toBe(340);
    const values = [...rail.querySelectorAll<HTMLElement>("[data-tone]")];
    expect(values.map(value => value.textContent), "actual nonempty degree and hop facts").toEqual(["2", "3", "1 hop"]);
    const keys = values.map(value => value.previousElementSibling as HTMLElement);
    expect(keys.map(key => key.textContent)).toEqual(["in-degree", "out-degree", "hops"]);
    const card = keys[0]!.parentElement!.parentElement!.parentElement!;
    for (const [i, key] of keys.entries()) {
      expect(key.getBoundingClientRect().width, "caller's 72px floor").toBe(72);
      expect(values[i]!.getBoundingClientRect().left - card.getBoundingClientRect().left, "actual caller value edge").toBe(95);
      expect(key.getBoundingClientRect().height).toBe(15.75);
      const range = document.createRange();
      range.selectNodeContents(key);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      expect(rects.length, "actual nonempty glyph rects").toBeGreaterThan(0);
      expect(values[i]!.getBoundingClientRect().left - Math.max(...rects.map(rect => rect.right)), "actual graph glyph gutter").toBeGreaterThanOrEqual(9.5);
    }
    expect(keys[1]!.getBoundingClientRect().top - keys[0]!.getBoundingClientRect().top, "actual graph row pitch").toBe(20.75);
    expect(card.scrollWidth, "actual caller card containment").toBeLessThanOrEqual(card.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  });
}
