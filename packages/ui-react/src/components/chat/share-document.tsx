/**
 * What a shared PNG or PDF of an answer contains (#46).
 *
 * The share renderer takes markdown and runs no script, so blocks reach it as
 * static HTML: each is rendered here, in the browser, with the transcript's
 * own `BlockCard`, and embedded in the markdown as a raw HTML block, which
 * `marked` passes through. The kit's components read only `var(--bk-*)`, so
 * one `<style>` of print tokens is all they need; it comes from the kit, and
 * this package is the only one that knows both. `render-template` and the
 * server stay unaware of blocks.
 *
 * A message with no blocks sends exactly what it sent before this existed:
 * its `content`, mermaid diagrams inlined. Nothing about the common case moves.
 */
import { printThemeCss } from "@schlessera/brain-ui-kit";
import { SHOW_BLOCK_CONTRACT, parseToolPayload, type Block } from "@schlessera/brain-ui-sdk/client";

import { isShowBlockTool } from "../../lib/tool-names.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { usableBlocks } from "./markdown-content.js";
import { BlockCard } from "./tool-cards/block-card.js";

/** One piece of the shared answer, in the order the reader saw it. */
export type ShareSegment = { kind: "markdown"; text: string } | { kind: "block"; block: Block };

/**
 * The answer as the transcript draws it: each text part, with the blocks the
 * surface classified out of it cut in at their spans, and each `show_block`
 * call where the model made it. Order is the order of `message.parts`, which
 * is where the model wrote each piece, not when its payload arrived.
 *
 * Left out, as the transcript's answer leaves them out: thinking, the tool
 * trace, `ask_user` exchanges, and a `show_block` call whose payload does not
 * parse (the transcript shows that one only inside the trace).
 */
export function shareSegments(message: Pick<ChatMessage, "parts" | "toolCalls" | "blocks">): ShareSegment[] {
  const segments: ShareSegment[] = [];
  const markdown = (text: string) => {
    if (text.trim()) segments.push({ kind: "markdown", text });
  };
  // Classified blocks are anchored to the n-th TEXT part, whitespace-only
  // parts included, exactly as the transcript counts them.
  let textIndex = 0;
  for (const part of message.parts) {
    if (part.kind === "tool") {
      const tool = message.toolCalls[part.toolIndex];
      if (!tool || !isShowBlockTool(tool.name)) continue;
      const payload = parseToolPayload(SHOW_BLOCK_CONTRACT, tool.output);
      if (payload) segments.push({ kind: "block", block: payload.block });
      continue;
    }
    if (part.kind !== "text") continue;
    const own = message.blocks?.filter((b) => b.partIndex === textIndex);
    textIndex++;
    let cursor = 0;
    for (const cut of usableBlocks(part.text, own)) {
      markdown(part.text.slice(cursor, cut.start));
      segments.push({ kind: "block", block: cut.block });
      cursor = cut.end;
    }
    markdown(part.text.slice(cursor));
  }
  return segments;
}

/**
 * One block as static HTML on a single line. A blank line inside would end
 * `marked`'s HTML block and turn the rest into markdown, so newlines in the
 * block's text become the equivalent character reference.
 */
export async function renderBlockHtml(block: Block): Promise<string> {
  // Loaded on share, not with the chat: it is only ever needed here.
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(<BlockCard block={block} />).replace(/\r?\n/g, "&#10;");
}

/** The print tokens, and the layout a block needs on a page. */
export function shareStyle(): string {
  return (
    `<style>${printThemeCss()}` +
    "[data-block]{margin:1em 0}" +
    // A block is one unit: a PDF page break never splits one.
    "@media print{[data-block]{break-inside:avoid}}</style>"
  );
}

export interface ShareDeps {
  renderBlock: (block: Block) => Promise<string>;
  inlineMermaid: (markdown: string) => Promise<string>;
}

/**
 * The markdown the share renderer receives, for PNG and PDF alike.
 *
 * With no block in the answer, this is `message.content` with its mermaid
 * diagrams inlined: byte for byte what sharing sent before blocks existed.
 */
export async function shareMarkdown(
  message: Pick<ChatMessage, "content" | "parts" | "toolCalls" | "blocks">,
  deps: ShareDeps,
): Promise<string> {
  const segments = shareSegments(message);
  if (!segments.some((segment) => segment.kind === "block")) return deps.inlineMermaid(message.content);
  const pieces = await Promise.all(
    segments.map((segment) =>
      segment.kind === "markdown" ? deps.inlineMermaid(segment.text) : deps.renderBlock(segment.block),
    ),
  );
  return [shareStyle(), ...pieces].join("\n\n");
}
