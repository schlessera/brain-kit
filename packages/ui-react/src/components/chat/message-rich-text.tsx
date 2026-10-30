import type { BrainUiRoot } from "../../root.js";
import { BrainUiRootScope } from "../../root-context.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { loadTrackDisplay } from "../../lib/track-display.js";
import { BrainMarkdown } from "./brain-markdown.js";
import { MarkdownRangeContext } from "./markdown-range.js";
import { shareSegments } from "./share-document.js";
import { ContentRendererSurface } from "../content-renderer.js";
import { BlockCard } from "./tool-cards/block-card.js";

/** Render the complete semantic answer on demand, independently of its visible
 * arrivals or transcript window. Use the existing Markdown safety policy and
 * static data-only cards; no hidden duplicate transcript or DOM HTML injection.
 */
export async function renderMessageRichText(
  root: BrainUiRoot,
  message: Pick<ChatMessage, "content" | "parts" | "toolCalls" | "blocks">,
): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const segments = shareSegments(message);
  const pieces = await Promise.all(segments.map(async (segment, index) => {
    if (segment.kind === "markdown") return <BrainMarkdown key={index} content={segment.text} fileLinks />;
    const block = segment.block;
    const track = block.kind === "track" ? await loadTrackDisplay(root, block.source.path, block.title) : undefined;
    return <BlockCard key={index} block={block} isStatic trackDisplay={track} />;
  }));
  return renderToStaticMarkup(
    <BrainUiRootScope value={root}>
      <ContentRendererSurface.Provider value={{ mode: "share" }}>
        <MarkdownRangeContext.Provider value={null}>
          {pieces.length ? pieces : <BrainMarkdown content={message.content} fileLinks />}
        </MarkdownRangeContext.Provider>
      </ContentRendererSurface.Provider>
    </BrainUiRootScope>,
  );
}
