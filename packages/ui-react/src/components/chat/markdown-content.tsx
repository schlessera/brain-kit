import type { MessageBlock } from "@schlessera/brain-ui-sdk/protocol";
import { BrainMarkdown } from "./brain-markdown.js";
import { BlockCard } from "./tool-cards/block-card.js";
import { holdOpenLink } from "../../lib/stream-link-hold.js";
import { MarkdownRangeContext, type MarkdownRange } from "./markdown-range.js";

/**
 * A text part of an assistant message, with the blocks the surface
 * classified out of it drawn in place (D42).
 *
 * The blocks are anchored by character span. The part is cut at those
 * spans and each piece renders as markdown, with the kit block between —
 * so a table the model typed becomes a comparison table without touching
 * the markdown renderer, and a message with no blocks renders exactly as it
 * did before this prop existed. A span that does not fit the text (an
 * anchor from a text that has since changed) is ignored, never a blank.
 *
 * While the part is still streaming, a link that has not closed yet is held
 * back (`holdOpenLink`, #551), so no raw address is painted and no autolink
 * to a half-typed host exists for a frame. The anchor and its host appear
 * together once the link closes.
 */
export function MarkdownContent({
  content: buffer,
  blocks,
  streaming = false,
  range,
}: {
  content: string;
  blocks?: MessageBlock[];
  streaming?: boolean;
  /** Coordinates in the original full text part, never in an arrival substring. */
  range?: MarkdownRange;
}) {
  const content = streaming ? holdOpenLink(buffer).shown : buffer;
  const cuts = usableBlocks(content, blocks);
  const markdown = (text: string, offset: number, key?: string) => (
    <MarkdownRangeContext.Provider key={key} value={range ? { start: range.start - offset, end: range.end - offset } : null}>
      <BrainMarkdown content={text} fileLinks />
    </MarkdownRangeContext.Provider>
  );
  if (cuts.length === 0) return markdown(content, 0);
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  cuts.forEach((cut, i) => {
    const before = content.slice(cursor, cut.start);
    if (before.trim()) pieces.push(markdown(before, cursor, `md-${i}`));
    if (!range || cut.start >= range.start && cut.start < range.end) pieces.push(
      <div key={`block-${i}`} className="my-3" data-classified-block={cut.block.kind}>
        <BlockCard block={cut.block} />
      </div>
    );
    cursor = cut.end;
  });
  const after = content.slice(cursor);
  if (after.trim()) pieces.push(markdown(after, cursor, "md-tail"));
  return <>{pieces}</>;
}

/** The blocks whose spans fit this text, in order, non-overlapping. */
export function usableBlocks(content: string, blocks: MessageBlock[] | undefined): MessageBlock[] {
  if (!blocks || blocks.length === 0) return [];
  const sorted = [...blocks]
    // A span of the answer's prose is never swapped for suggestions: they
    // are drawn under the answer (D50), so the prose would simply vanish.
    // The pass cannot produce one; this keeps a forged frame from trying.
    .filter((b) => b.block.kind !== "suggestions")
    .filter((b) => b.start >= 0 && b.end > b.start && b.end <= content.length)
    .sort((a, b) => a.start - b.start);
  const out: MessageBlock[] = [];
  let cursor = 0;
  for (const block of sorted) {
    if (block.start < cursor) continue;
    out.push(block);
    cursor = block.end;
  }
  return out;
}
