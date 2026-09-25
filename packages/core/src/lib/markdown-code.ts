/**
 * Where the code is in a markdown document, as a GFM parser reads it
 * (remark-parse and remark-gfm, the parser document-parts.ts uses). A fence
 * inside a blockquote or a list item, an indented block and an inline span of
 * any backtick length are all code. A hand-written line scanner gets
 * containers and one-line triple-backtick spans wrong. Checks that must skip
 * code (`brain audit`'s `past-date`, `brain doctor`'s `instructions-weight`)
 * ask here.
 */

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/*
 * The slice of mdast this reads, typed structurally (see document-parts.ts
 * for why not through `@types/mdast`).
 */
interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

const markdown = unified().use(remarkParse).use(remarkGfm);

/** `[start, end)` offsets of every code block and inline code span in `text`. */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const walk = (node: MdNode) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(markdown.parse(text) as MdNode);
  return ranges;
}

/** Whether `offset` falls inside one of `ranges`. */
export function inRanges(ranges: [number, number][], offset: number): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}
