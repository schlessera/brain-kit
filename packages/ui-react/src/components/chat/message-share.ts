import { uiConfig } from "../../config.js";
import type { RefObject } from "react";
import { renderAndShare, shareFile, shareText, copyRichText } from "../../lib/share.js";
import { stripMarkdown } from "../../lib/strip-markdown.js";
import { inlineMermaidDiagrams } from "../../lib/mermaid.js";
import type { ShareOption } from "../share/share-menu.js";

interface BuildOpts {
  content: string;
  /** Ref to the rendered message DOM. Used to grab outerHTML for rich-text copy. */
  renderedRef: RefObject<HTMLElement | null>;
}

export function buildMessageShareOptions({ content, renderedRef }: BuildOpts): ShareOption[] {
  const plain = () => stripMarkdown(content);

  return [
    {
      id: "image",
      label: "Image (PNG)",
      hint: "Rendered snapshot",
      run: async () =>
        renderAndShare({
          // The render page runs without JavaScript, so mermaid fences are
          // pre-rendered to inline SVG here on the client.
          content: await inlineMermaidDiagrams(content),
          contentType: "markdown",
          format: "png",
          filename: "message",
          title: uiConfig.shareTitle,
        }),
    },
    {
      id: "pdf",
      label: "PDF",
      hint: "Vector PDF, A4",
      run: async () =>
        renderAndShare({
          content: await inlineMermaidDiagrams(content),
          contentType: "markdown",
          format: "pdf",
          filename: "message",
          title: uiConfig.shareTitle,
        }),
    },
    {
      id: "text",
      label: "Plain text",
      hint: "Markdown stripped",
      run: () => shareText({ text: plain() }),
    },
    {
      id: "markdown",
      label: "Markdown source",
      hint: "Raw markdown verbatim",
      run: () =>
        shareFile(new File([content], "message.md", { type: "text/markdown" }), {
          title: uiConfig.shareTitle,
        }),
    },
    {
      id: "richtext",
      label: "Copy as rich text",
      hint: "Paste into Gmail / Docs",
      run: async () => {
        const node = renderedRef.current;
        const html = node?.innerHTML ?? `<p>${escapeHtml(plain())}</p>`;
        return copyRichText(html, plain());
      },
    },
  ];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
