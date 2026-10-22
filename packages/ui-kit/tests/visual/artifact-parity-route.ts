/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

const pattern = "**/api/files/content?*";

/** The artifact consumer stories draw one PDF from the raw file route. pdf.js
 * fetches it natively, outside the root's request seam, so the page serves
 * these local bytes for that exact same-origin path and refuses anything else.
 * `null` removes the route. Route outcomes, auth and races stay runtime proof. */
export const artifactParityRoute: BrowserCommand<[string | null], void> = async (ctx, path) => {
  await ctx.page.unroute(pattern);
  if (path === null) return;
  const origin = new URL(ctx.page.url()).origin;
  await ctx.page.route(pattern, route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== "GET" || url.searchParams.get("path") !== path || url.searchParams.get("raw") !== "1") return route.abort();
    return route.fulfill({ status: 200, contentType: "application/pdf", body: pdf() });
  });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    artifactParityRoute(path: string | null): Promise<void>;
  }
}

/** The runtime fixture's one fictional page (`artifact-recovery-runtime.test.ts`). */
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
