/**
 * The open conversation's side of link promotion (#1698): the host saved the
 * turn's answer linking promoted copies, and says which destinations changed
 * (`message_links`). The streamed text is rewritten with the function the
 * backend used, so it comes out as the saved text, and the classified blocks
 * anchored to the streamed text follow it.
 */
import { rewriteLinkDestinationsWithEdits, type LinkEdit } from "@schlessera/brain-ui-sdk/internal/client";
import type { MessageBlock } from "@schlessera/brain-ui-sdk/protocol";

/** Each streamed text rewritten with every link the host has named so far. */
export function rewriteTexts(texts: readonly string[], links: Readonly<Record<string, string>>) {
  const map = new Map(Object.entries(links));
  return texts.map((text) => rewriteLinkDestinationsWithEdits(text, (destination) => map.get(destination) ?? destination));
}

/**
 * Blocks anchored to the streamed text parts, moved to the rewritten ones.
 * A block a change cuts across, or in a part whose changes overlap, is
 * dropped: it is drawn as plain markdown rather than over the wrong text.
 */
export function rebaseBlocks(blocks: readonly MessageBlock[], edits: ReadonlyArray<LinkEdit[] | null>): MessageBlock[] {
  return blocks.flatMap((block) => {
    const part = edits[block.partIndex];
    if (part === undefined) return [block];
    if (part === null) return [];
    let start = block.start, end = block.end;
    for (const edit of part) {
      const delta = edit.length - (edit.end - edit.start);
      if (edit.end <= block.start) { start += delta; end += delta; }
      else if (edit.start >= block.end) break;
      else if (edit.start >= block.start && edit.end <= block.end) end += delta;
      else return [];
    }
    return [{ ...block, start, end }];
  });
}
