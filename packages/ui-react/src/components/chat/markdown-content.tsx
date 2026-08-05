import { BrainMarkdown } from "./brain-markdown.js";

export function MarkdownContent({ content }: { content: string }) {
  return <BrainMarkdown content={content} fileLinks />;
}
