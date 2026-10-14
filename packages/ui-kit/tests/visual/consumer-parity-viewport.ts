/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

/** Outer browser dimensions prevent Vitest scaling the measured story iframe.
 * Width-specific responsive proof uses page.viewport on that iframe as well. */
export const consumerParityViewport: BrowserCommand<[number | null, { width: number; height: number }?], { width: number; height: number }> = async (ctx, width, restore) => {
  await ctx.page.unroute("**/api/files/content?*");
  if (width !== null) {
    const origin = new URL(ctx.page.url()).origin;
    await ctx.page.route("**/api/files/content?*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.searchParams.get("path") !== ".brain/scratch/raft/overview.pdf" || url.searchParams.get("raw") !== "1") return route.abort();
      return route.fulfill({ status: 200, contentType: "application/pdf", body: pdf() });
    });
  }
  const before = ctx.page.viewportSize();
  if (!before) throw new Error("Consumer parity requires a native viewport");
  await ctx.page.setViewportSize(width === null ? restore! : { width: width + 100, height: 920 });
  await ctx.page.emulateMedia({ reducedMotion: width === null ? null : "reduce" });
  return before;
};

declare module "vitest/browser" {
  interface BrowserCommands {
    consumerParityViewport(width: number | null, restore?: { width: number; height: number }): Promise<{ width: number; height: number }>;
  }
}

/** One fictional page; bytes stay local to the native route fixture. */
function pdf(): Buffer {
  const stream = "BT /F1 24 Tf 72 720 Td (Odysseus reviews the raft) Tj ET";
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(out + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
