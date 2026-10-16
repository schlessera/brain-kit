import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import type { ContentRendererTheme } from "@schlessera/brain-ui-sdk/render";
import { registerBuiltinContentRenderers } from "../content-renderers/index.js";
import { findContentFences } from "./content-fences.js";

// The render endpoint's content bound is512 KiB. Preserve space for the envelope.
const INLINE_BUDGET_BYTES = 480_000;

/** Browser-only packs must finish before the no-script share renderer receives markdown. */
export async function preRenderBrowserFences(markdown: string, theme: ContentRendererTheme = "print"): Promise<string> {
  registerBuiltinContentRenderers();
  const fences = findContentFences(markdown).flatMap(fence => {
    const renderer = defaultContentRendererRegistry.forLanguage(fence.language);
    return renderer?.needsBrowser ? [{ ...fence, renderer }] : [];
  });
  const rendered = await Promise.all(fences.map(async fence => {
    try { return await fence.renderer.toStatic(fence.source, { theme }); }
    catch {
      console.warn("Content renderer share lint", { language: fence.language, offset: fence.start, reason: "static rendering failed; source retained" });
      return null;
    }
  }));
  let total = new TextEncoder().encode(markdown).length;
  let output = markdown;
  for (let index = fences.length - 1; index >= 0; index--) {
    const fence = fences[index], html = rendered[index];
    if (!html) continue;
    const replacement = `\n${fence.indent}${html.replace(/[\r\n]+/g, " ")}\n`;
    const expanded = total + new TextEncoder().encode(replacement).length
      - new TextEncoder().encode(markdown.slice(fence.start, fence.end)).length;
    if (expanded > INLINE_BUDGET_BYTES) {
      console.warn("Content renderer share lint", { language: fence.language, offset: fence.start, reason: "inline byte budget exceeded; source retained" });
      continue;
    }
    total = expanded;
    output = output.slice(0, fence.start) + replacement + output.slice(fence.end);
  }
  return output;
}
