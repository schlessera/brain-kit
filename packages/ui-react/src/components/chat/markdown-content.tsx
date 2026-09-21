import type { MessageBlock } from "@schlessera/brain-ui-sdk/protocol";
import { BrainMarkdown } from "./brain-markdown.js";
import { BlockCard } from "./tool-cards/block-card.js";

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
 */
export function MarkdownContent({
  content,
  blocks,
}: {
  content: string;
  blocks?: MessageBlock[];
}) {
  const cuts = usableBlocks(content, blocks);
  if (cuts.length === 0) return <BrainMarkdown content={content} fileLinks />;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  cuts.forEach((cut, i) => {
    const before = content.slice(cursor, cut.start);
    if (before.trim()) pieces.push(<BrainMarkdown key={`md-${i}`} content={before} fileLinks />);
    pieces.push(
      <div key={`block-${i}`} className="my-3" data-classified-block={cut.block.kind}>
        <BlockCard block={cut.block} />
      </div>
    );
    cursor = cut.end;
  });
  const after = content.slice(cursor);
  if (after.trim()) pieces.push(<BrainMarkdown key="md-tail" content={after} fileLinks />);
  return <>{pieces}</>;
}

/** The blocks whose spans fit this text, in order, non-overlapping. */
export function usableBlocks(content: string, blocks: MessageBlock[] | undefined): MessageBlock[] {
  if (!blocks || blocks.length === 0) return [];
  const sorted = [...blocks]
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
