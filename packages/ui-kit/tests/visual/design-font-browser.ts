/// <reference types="@vitest/browser-playwright" />
import { randomUUID } from "node:crypto";
import type { BrowserCommand } from "vitest/node";

export interface PaintedFont {
  familyName: string;
  postScriptName: string;
  isCustomFont: boolean;
  glyphCount: number;
}

/** Inspect painted glyphs, rather than the declared CSS family or fonts.check(). */
export const designFontUsage: BrowserCommand<[string], PaintedFont[][]> = async (ctx, selector) => {
  const frame = await ctx.frame();
  const marker = randomUUID();
  const count = await frame.locator(selector).evaluateAll((nodes, marker) => {
    nodes.forEach((node, i) => node.setAttribute("data-design-font-probe", `${marker}-${i}`));
    return nodes.length;
  }, marker);
  if (!count) throw new Error(`No painted font targets: ${selector}`);
  const session = await ctx.page.context().newCDPSession(ctx.page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const ids = new Map<string, number>();
    const walk = (node: typeof root) => {
      for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) {
        if (node.attributes![i] === "data-design-font-probe") ids.set(node.attributes![i + 1]!, node.nodeId);
      }
      node.children?.forEach(walk);
      if (node.contentDocument) walk(node.contentDocument);
      node.shadowRoots?.forEach(walk);
    };
    walk(root);
    return await Promise.all(Array.from({ length: count }, async (_, i) => {
      const nodeId = ids.get(`${marker}-${i}`);
      if (!nodeId) throw new Error(`Font target missing from Chromium DOM: ${i}`);
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      return fonts;
    }));
  } finally {
    await session.detach();
    await frame.locator(selector).evaluateAll(nodes => nodes.forEach(node => node.removeAttribute("data-design-font-probe")));
  }
};

declare module "vitest/browser" {
  interface BrowserCommands {
    designFonts(): Promise<string>;
    designFontUsage(selector: string): Promise<PaintedFont[][]>;
  }
}
