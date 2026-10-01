/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFontLock, verifyFontCache } from "../../../../scripts/captures/fonts.js";

/** Reuse the checksum-verified preview faces; browser tests never download fonts. */
export const rankFooterFonts: BrowserCommand<[], string> = async () => {
  const root = resolve("../..");
  const { hash } = await readFontLock(root);
  const fonts = await verifyFontCache(root, resolve(tmpdir(), "brain-kit-feature-capture-fonts", hash));
  let css = Buffer.from(fonts.css).toString("utf8");
  for (const asset of fonts.lock.assets) {
    css = css.replace(asset.url, `data:font/ttf;base64,${Buffer.from(fonts.files.get(asset.url)!).toString("base64")}`);
  }
  return css;
};

/** A real fine-pointer gesture through Chromium, including native pointer capture. */
export const rankFooterDrag: BrowserCommand<[]> = async (ctx) => {
  const frame = await ctx.frame();
  const from = await frame.locator("[data-rank-handle]").nth(2).boundingBox();
  const to = await frame.locator("[data-rank-row]").first().boundingBox();
  if (!from || !to) throw new Error("Five-choice ranking is not painted");
  await ctx.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await ctx.page.mouse.down();
  try { await ctx.page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 6 }); }
  finally { await ctx.page.mouse.up(); }
};

/** Review pixels survive a failing readability assertion and stay outside baselines. */
export const rankFooterCapture: BrowserCommand<[string]> = async (ctx, name) => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid capture name");
  const dir = resolve(".vitest-attachments/rank-footer");
  await mkdir(dir, { recursive: true });
  const frame = await ctx.frame();
  await frame.locator(".bk-askrank").screenshot({ path: resolve(dir, `${name}.png`) });
  const geometry = await frame.evaluate(() => {
    const hint = document.querySelector<HTMLElement>(".bk-rank-keys")?.getBoundingClientRect();
    const actions = [...document.querySelectorAll<HTMLElement>('[data-rank-actions] button, [data-rank-actions] [role="button"]')].map((button) => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      return { name: button.textContent?.trim(), width: bounds.width, height: bounds.height,
        reaches44px: [-21.5, 21.5].every((dy) => document.elementFromPoint(x, y + dy)?.closest('[role="button"],button') === button) };
    });
    return { hint: hint ? { width: hint.width, height: hint.height } : null, actions };
  });
  await writeFile(resolve(dir, `${name}.json`), JSON.stringify(geometry, null, 2));
};

declare module "vitest/browser" {
  interface BrowserCommands {
    rankFooterFonts(): Promise<string>;
    rankFooterDrag(): Promise<void>;
    rankFooterCapture(name: string): Promise<void>;
  }
}
