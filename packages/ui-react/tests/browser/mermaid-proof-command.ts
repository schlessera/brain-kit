/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Real Chromium media and document output, with every external request denied. */
export const mermaidMedia: BrowserCommand<["screen" | "print"]> = async (ctx, media) => {
  await ctx.page.emulateMedia({ media });
};
export const mermaidOutput: BrowserCommand<[string], { png: string; pdfBytes: number; requests: string[] }> = async (ctx, html) => {
  const page = await ctx.context.newPage();
  const requests: string[] = [];
  await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
  try {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(`<html><body style="margin:0;background:white">${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot();
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    const directory = resolve("../../tmp/mermaid-renderer-proof");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "print.png"), png);
    await writeFile(resolve(directory, "print.pdf"), pdf);
    await writeFile(resolve(directory, "print.html"), html);
    return { png: png.toString("base64"), pdfBytes: pdf.length, requests };
  } finally { await page.close(); }
};
export const mermaidScreenComparison: BrowserCommand<[string, string, string], boolean> = async (ctx, theme, before, after) => {
  const page = await ctx.context.newPage();
  await page.route("**/*", route => route.abort());
  try {
    await page.setViewportSize({ width: 800, height: 600 });
    const captures: Buffer[] = [];
    const directory = resolve("../../tmp/mermaid-renderer-proof");
    await mkdir(directory, { recursive: true });
    for (const [name, html] of [["before", before], ["after", after]]) {
      await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
      await page.evaluate(() => document.fonts.ready);
      const capture = await page.screenshot();
      await writeFile(resolve(directory, `${theme}-${name}.png`), capture);
      captures.push(capture);
    }
    return captures[0]!.equals(captures[1]!);
  } finally { await page.close(); }
};
declare module "vitest/browser" {
  interface BrowserCommands {
    mermaidScreenComparison(theme: string, before: string, after: string): Promise<boolean>;
    mermaidMedia(media: "screen" | "print"): Promise<void>;
    mermaidOutput(html: string): Promise<{ png: string; pdfBytes: number; requests: string[] }>;
  }
}
