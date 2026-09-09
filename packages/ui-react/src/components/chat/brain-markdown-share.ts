import type { ShareBlockFormat } from "./share-block.js";

type ShareSegment = { kind: "share"; format: ShareBlockFormat; title?: string; body: string };
type TextSegment = { kind: "text"; text: string };
export type Segment = TextSegment | ShareSegment;

const SHARE_BLOCK_RE = /<share\b([^>]*)>([\s\S]*?)<\/share>/gi;
const VALID_FORMATS: ReadonlySet<ShareBlockFormat> = new Set([
  "image",
  "pdf",
  "text",
  "markdown",
  "richtext",
]);

function parseShareAttrs(raw: string): { format: ShareBlockFormat; title?: string } {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  const format = (attrs.format ?? "image").toLowerCase() as ShareBlockFormat;
  return {
    format: VALID_FORMATS.has(format) ? format : "image",
    title: attrs.title,
  };
}

export function splitShareBlocks(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SHARE_BLOCK_RE.lastIndex = 0;
  while ((m = SHARE_BLOCK_RE.exec(input)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: input.slice(last, m.index) });
    }
    const { format, title } = parseShareAttrs(m[1] ?? "");
    out.push({ kind: "share", format, title, body: m[2].trim() });
    last = SHARE_BLOCK_RE.lastIndex;
  }
  if (last < input.length) {
    out.push({ kind: "text", text: input.slice(last) });
  }
  return out;
}
