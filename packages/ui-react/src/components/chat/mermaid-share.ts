import { uiConfig } from "../../config.js";
import { renderMermaidSvg, sizeSvgForExport } from "../../lib/mermaid.js";
import { renderAndShare, shareFile, shareText } from "../../lib/share.js";
import type { ShareOption } from "../share/share-menu.js";

/**
 * Share options for a single diagram.
 *
 * Exports are rendered in the LIGHT theme, not the dark one on screen: a share
 * lands in WhatsApp, a mail client or a printer, all of which assume paper.
 * PNG and PDF go through the same /api/render path as every other share, so a
 * diagram in a shared message and a diagram shared on its own are the same
 * pixels.
 */

/** Guard: the render route rejects a body over 512 KiB, so fail with a readable message. */
const MAX_CONTENT_CHARS = 480_000;

function figureHtml(svg: string, tight: boolean): string {
  // `width: fit-content` is what makes a PNG crop to the diagram instead of to
  // the render viewport — the screenshot clips to the body box. PDF keeps the
  // template's normal page flow, since an A4 page has a fixed width anyway.
  const style = tight
    ? "<style>body{width:fit-content;padding:24px}.mermaid-figure{margin:0}</style>"
    : "";
  return `${style}<div class="mermaid-figure">${svg.replace(/[\r\n]+/g, " ")}</div>`;
}

async function exportSvg(source: string): Promise<string> {
  const svg = await renderMermaidSvg(source, "light");
  if (!svg) throw new Error("This diagram can't be rendered yet");
  return sizeSvgForExport(svg);
}

async function exportHtml(source: string, tight: boolean): Promise<string> {
  const html = figureHtml(await exportSvg(source), tight);
  if (html.length > MAX_CONTENT_CHARS) {
    throw new Error("Diagram is too large to share as an image");
  }
  return html;
}

export function buildDiagramShareOptions(
  source: string,
  opts: { filename?: string } = {}
): ShareOption[] {
  const filename = opts.filename ?? "diagram";
  return [
    {
      id: "image",
      label: "Image (PNG)",
      hint: "Cropped to the diagram",
      run: async () =>
        renderAndShare({
          content: await exportHtml(source, true),
          contentType: "html",
          format: "png",
          filename,
          title: uiConfig.shareTitle,
        }),
    },
    {
      id: "pdf",
      label: "PDF",
      hint: "Vector PDF, A4",
      run: async () =>
        renderAndShare({
          content: await exportHtml(source, false),
          contentType: "html",
          format: "pdf",
          filename,
          title: uiConfig.shareTitle,
        }),
    },
    {
      id: "svg",
      label: "Vector (SVG)",
      hint: "Scales to any size",
      run: async () =>
        shareFile(new File([await exportSvg(source)], `${filename}.svg`, { type: "image/svg+xml" }), {
          title: uiConfig.shareTitle,
        }),
    },
    {
      id: "source",
      label: "Mermaid source",
      hint: "Paste into another tool",
      run: () => shareText({ text: source, title: uiConfig.shareTitle }),
    },
  ];
}
