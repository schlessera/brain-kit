import { createContext } from "react";
import { decodeString } from "micromark-util-decode-string";
import { scanBarePaths } from "./brain-markdown-links.js";

/** Internal source coordinates, applied after the ordinary Markdown parse. */
export interface MarkdownRange { start: number; end: number }
export const MarkdownRangeContext = createContext<MarkdownRange | null>(null);

interface MarkdownNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Indivisible constructs keep their complete syntax, destination and actions. */
const ATOMIC = new Set(["a", "img", "code", "pre", "table", "sup", "input", "br", "hr"]);
// Growing code/tables retain the anchor where their content first appeared.
const START_ANCHORED = new Set(["code", "pre", "table", "input"]);
const ESCAPE = /\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|\r\n|[\uD800-\uDBFF][\uDC00-\uDFFF]/gi;

/**
 * Text offsets refer to Markdown source, not its decoded value. Keep an escape,
 * character reference CRLF or Unicode scalar indivisible and assign it at its source end.
 */
function textInRange(raw: string, value: string, offset: number, range: MarkdownRange, fileLinks: boolean): string {
  let at = 0, decoded = "";
  const starts: number[] = [], ends: number[] = [];
  const append = (text: string, from: number, to: number, atomic: boolean) => {
    decoded += text;
    for (let i = 0; i < text.length; i++) {
      starts.push(atomic ? from : from + i);
      ends.push(atomic ? to : from + i + 1);
    }
  };
  for (const match of raw.matchAll(ESCAPE)) {
    append(raw.slice(at, match.index), offset + at, offset + match.index, false);
    const token = match[0] === "\r\n" ? "\n" : decodeString(match[0]);
    append(token, offset + match.index, offset + match.index + match[0].length, true);
    at = match.index + match[0].length;
  }
  append(raw.slice(at), offset + at, offset + raw.length, false);
  if (decoded !== value) return offset + raw.length > range.start && offset + raw.length <= range.end ? value : "";
  const paths = fileLinks ? scanBarePaths(value) : [];
  let selected = "", pathIndex = 0;
  for (let i = 0; i < value.length;) {
    const path = paths[pathIndex];
    let end = i + 1;
    if (path?.start === i) { end = path.end; pathIndex++; }
    else while (end < value.length && starts[end] === starts[i] && ends[end] === ends[i]) end++;
    if (ends[end - 1]! > range.start && ends[end - 1]! <= range.end) selected += value.slice(i, end);
    i = end;
  }
  return selected;
}

/**
 * Select the fully resolved HTML tree, not independent Markdown substrings.
 * The ordinary parser, reference/footnote resolution and raw-href guard run
 * first. Growing code/tables keep their original anchor; held links/images and
 * post-parse path tokens appear once at completion. No HTML is executed, and
 * existing components retain their behavior and tool/action bindings.
 */
export function rehypeMarkdownRange({ source, start, end, fileLinks }: MarkdownRange & { source: string; fileLinks: boolean }) {
  return (tree: MarkdownNode) => {
    const ownsStart = (at: number) => at >= start && at < end;
    const ownsEnd = (at: number) => at > start && at <= end;
    const footnoteAnchor = (node: MarkdownNode): number => {
      if (node.tagName === "li" && node.position?.start.offset !== undefined) return node.position.start.offset;
      return Math.min(...(node.children ?? []).map(footnoteAnchor), Infinity);
    };
    const select = (node: MarkdownNode, parentStart = 0): MarkdownNode | null => {
      // Convert the complete document first: numbering, IDs and every backref
      // remain correct even when references straddle several arrival ranges.
      if (node.properties?.dataFootnotes) {
        const at = footnoteAnchor(node);
        return ownsStart(Number.isFinite(at) ? at : Math.max(0, source.length - 1)) ? node : null;
      }
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (node.type !== "root" && (from === undefined || to === undefined)) return ownsStart(parentStart) ? node : null;
      if (node.type !== "root" && (to! <= start || from! >= end)) return null;
      if (node.type === "raw" || ATOMIC.has(node.tagName ?? "")) return START_ANCHORED.has(node.tagName ?? "")
        ? ownsStart(from!) ? node : null : ownsEnd(to!) ? node : null;
      if (node.type === "text") {
        const value = textInRange(source.slice(from, to), node.value ?? "", from!, { start, end }, fileLinks);
        return value ? { ...node, value } : null;
      }
      if (node.children) {
        const ordered = node.tagName === "ol";
        const reversed = node.properties?.reversed === true;
        const startValue = Number(node.properties?.start);
        let ordinal = Number.isFinite(startValue) ? startValue : reversed ? node.children.filter(child => child.tagName === "li").length : 1;
        let firstOrdinal: number | undefined;
        const children: MarkdownNode[] = [];
        for (const child of node.children) {
          const item = ordered && child.tagName === "li";
          const explicit = Number(child.properties?.value);
          if (item && Number.isFinite(explicit)) ordinal = explicit;
          const kept = select(child, from ?? parentStart);
          if (kept) {
            if (item) {
              firstOrdinal ??= ordinal;
              // Keep source numbering even if earlier siblings were selected
              // in another arrival, or an explicit item value resets the count.
              children.push({ ...kept, properties: { ...kept.properties, value: ordinal } });
            } else children.push(kept);
          }
          if (item) ordinal += reversed ? -1 : 1;
        }
        const properties = firstOrdinal === undefined ? node.properties : { ...node.properties, start: firstOrdinal };
        return children.length || node.type === "root" ? { ...node, properties, children } : null;
      }
      return ownsEnd(to!) ? node : null;
    };
    tree.children = select(tree)?.children ?? [];
  };
}
