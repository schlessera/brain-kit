import { createContext } from "react";
import { decodeString } from "micromark-util-decode-string";

/** Internal source coordinates, applied after the ordinary Markdown parse. */
export interface MarkdownRange { start: number; end: number }
export const MarkdownRangeContext = createContext<MarkdownRange | null>(null);

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Indivisible constructs keep their complete syntax, destination and actions. */
const ATOMIC = new Set(["link", "linkReference", "image", "imageReference", "inlineCode", "code", "table", "html", "footnoteReference", "break"]);
const ESCAPE = /\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|\r\n/gi;

/**
 * Text offsets refer to Markdown source, not its decoded value. Keep an escape,
 * character reference or CRLF indivisible and assign it at its source end.
 */
function textInRange(raw: string, value: string, offset: number, range: MarkdownRange): string {
  let at = 0, decoded = "", selected = "";
  const append = (text: string, from: number, to: number, atomic: boolean) => {
    decoded += text;
    if (atomic) {
      if (to > range.start && to <= range.end) selected += text;
    } else {
      selected += text.slice(Math.max(0, range.start - from), Math.max(0, Math.min(text.length, range.end - from)));
    }
  };
  for (const match of raw.matchAll(ESCAPE)) {
    append(raw.slice(at, match.index), offset + at, offset + match.index, false);
    const token = match[0] === "\r\n" ? "\n" : decodeString(match[0]);
    append(token, offset + match.index, offset + match.index + match[0].length, true);
    at = match.index + match[0].length;
  }
  append(raw.slice(at), offset + at, offset + raw.length, false);
  // A future parser normalization must never lose or duplicate its text. An
  // unfamiliar indivisible value uses the same once-only source-end owner.
  return decoded === value ? selected : offset + raw.length > range.start && offset + raw.length <= range.end ? value : "";
}

/**
 * Select rendered content, not substrings to parse independently. Structural
 * wrappers retain inline/list context. Definitions remain available to resolve
 * references; links, code, tables and images occur once at their source end.
 * No HTML is executed and the existing renderer still owns all components.
 */
export function remarkMarkdownRange({ source, start, end }: MarkdownRange & { source: string }) {
  return (tree: MarkdownNode) => {
    const select = (node: MarkdownNode): MarkdownNode | null => {
      if (node.type === "definition" || node.type === "footnoteDefinition") return node;
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (node.type !== "root" && (from === undefined || to === undefined || to <= start || from >= end)) return null;
      if (ATOMIC.has(node.type)) return to! > start && to! <= end ? node : null;
      if (node.type === "text") {
        const value = textInRange(source.slice(from, to), node.value ?? "", from!, { start, end });
        return value ? { ...node, value } : null;
      }
      if (node.children) {
        const children = node.children.flatMap(child => { const kept = select(child); return kept ? [kept] : []; });
        return children.length || node.type === "root" ? { ...node, children } : null;
      }
      return to! > start && to! <= end ? node : null;
    };
    tree.children = select(tree)?.children ?? [];
  };
}
