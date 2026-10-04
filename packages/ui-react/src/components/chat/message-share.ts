import { loadTrackDisplay } from "../../lib/track-display.js";
import type { BrainUiRoot } from "../../root.js";
import type { RefObject } from "react";
import { renderAndShare, shareFile, shareText, copyRichText } from "../../lib/share.js";
import { stripMarkdown } from "../../lib/strip-markdown.js";
import { inlineMermaidDiagrams } from "../../lib/mermaid.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import type { ShareOption } from "../share/share-menu.js";
import { renderBlockHtml, shareMarkdown } from "./share-document.js";

interface BuildOpts {
  message: Pick<ChatMessage, "content" | "parts" | "toolCalls" | "blocks">;
  /** Ref to the rendered message DOM. Used to grab outerHTML for rich-text copy. */
  renderedRef: RefObject<HTMLElement | null>;
}

export function buildMessageShareOptions(root: BrainUiRoot, { message, renderedRef }: BuildOpts): ShareOption[] {
  const { content } = message;
  const plain = () => stripMarkdown(content);
  // PNG and PDF draw the same document: the answer's text and its blocks in
  // the print theme (#46). The render page runs no JavaScript, so mermaid
  // fences are pre-rendered to inline SVG and blocks to static HTML here.
  const rendered = () =>
    shareMarkdown(message, { renderBlock: async block => renderBlockHtml(block, block.kind === "track" ? await loadTrackDisplay(root, block.source.path, block.title) : undefined), inlineMermaid: (md) => inlineMermaidDiagrams(md) });

  return [
    {
      id: "image",
      label: "Image (PNG)",
      hint: "Rendered snapshot",
      run: async () =>
        renderAndShare(root, {
          content: await rendered(),
          contentType: "markdown",
          format: "png",
          filename: "message",
          title: root.config.shareTitle,
        }),
    },
    {
      id: "pdf",
      label: "PDF",
      hint: "Vector PDF, A4",
      run: async () =>
        renderAndShare(root, {
          content: await rendered(),
          contentType: "markdown",
          format: "pdf",
          filename: "message",
          title: root.config.shareTitle,
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
          title: root.config.shareTitle,
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
