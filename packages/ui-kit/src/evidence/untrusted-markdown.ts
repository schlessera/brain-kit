/**
 * The safe markdown subset `UntrustedText` renders (#3800, design #3795 §3/§3′).
 *
 * Text written somewhere Brain does not control (a GitHub issue body, a
 * comment) is markdown by convention, and plain text would turn its lists,
 * task boxes and code into `**` and `- [ ]` noise. This parser keeps the
 * subset that carries meaning and turns everything else into text:
 *
 * - **Blocks:** paragraphs, fenced code, lists (task boxes as static marks),
 *   blockquotes and headings (rendered as bold paragraphs).
 * - **Inline:** emphasis, strong, inline code, links and images.
 * - **Links** keep their words and their raw address. The renderer classifies
 *   the address; this module never decides whether one may open.
 * - **Images** become a named placeholder. The address is kept only so the
 *   renderer can name its host; nothing here, or in the renderer, loads it.
 * - **HTML** is never parsed. A tag is literal text, shown as code.
 * - **Bare URLs** are not autolinked. They are marked so the renderer can set
 *   them in mono, as text.
 *
 * Pure: no DOM, no React. Every loop is linear in the input, nesting is
 * bounded, and the input is capped by the caller (`maxChars`), so a hostile
 * body cannot make it slow.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "html"; text: string }
  | { type: "url"; text: string }
  | { type: "link"; children: Inline[]; url: string; text: string }
  | { type: "image"; alt: string; url: string };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "html"; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; items: ListItem[] };

interface ListItem {
  /** `null` for an ordinary item, otherwise the task box's state. */
  task: boolean | null;
  /** Nesting level from the item's indent, 0 to 3. */
  depth: number;
  children: Inline[];
}

const MAX_QUOTE_DEPTH = 3;
const MAX_INLINE_DEPTH = 4;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:\s+|$)/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
const TASK = /^\[([ xX])\]\s+/;
const TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/;
const COMMENT = /^<!--[\s\S]*?-->/;
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>]+/i;

/** Parses untrusted markdown into the safe subset. */
export function parseUntrusted(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}

function parseBlocks(lines: string[], quoteDepth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) body.push(lines[i++]!);
      i++; // the closing fence, or past the end when it is missing
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (HEADING.test(line)) {
      blocks.push({ type: "heading", children: parseInline(line.replace(HEADING, "").replace(/\s#+\s*$/, ""), 0) });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ""));
      // Past the depth bound a quote's lines are a paragraph: still shown,
      // never another level of recursion.
      blocks.push(
        quoteDepth < MAX_QUOTE_DEPTH
          ? { type: "quote", children: parseBlocks(body, quoteDepth + 1) }
          : { type: "paragraph", children: parseInline(body.join("\n"), 0) },
      );
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m) {
          // A non-blank, unmarked line continues the item above it.
          const next = lines[i]!;
          if (next.trim() === "" || items.length === 0 || FENCE.test(next) || HEADING.test(next) || QUOTE.test(next)) break;
          const last = items[items.length - 1]!;
          last.children.push({ type: "text", text: "\n" }, ...parseInline(next.trim(), 0));
          i++;
          continue;
        }
        let rest = lines[i]!.slice(m[0].length);
        const task = TASK.exec(rest);
        if (task) rest = rest.slice(task[0].length);
        items.push({
          task: task ? task[1] !== " " : null,
          depth: Math.min(3, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2)),
          children: parseInline(rest, 0),
        });
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Lines that open with a tag are HTML: shown whole, as literal code text,
    // never parsed.
    if (opensWithTag(line)) {
      const body: string[] = [];
      while (i < lines.length && opensWithTag(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ type: "html", text: body.join("\n") });
      continue;
    }

    // A paragraph runs to the next blank line or the next block marker.
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "" || FENCE.test(next) || HEADING.test(next) || QUOTE.test(next) || opensWithTag(next) || (body.length > 0 && ITEM.test(next))) break;
      body.push(next);
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(body.join("\n"), 0) });
  }
  return blocks;
}

function opensWithTag(line: string): boolean {
  const start = line.trimStart();
  return TAG.test(start) || COMMENT.test(start);
}

/** Parses one run of inline markdown. */
function parseInline(source: string, depth: number): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  const nested = (inner: string) => (depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1) : [{ type: "text" as const, text: inner }]);

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const rest = source.slice(i);

    if (ch === "\\" && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!<>~|]/.test(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = source.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        out.push({ type: "code", text: source.slice(i + run.length, close).replace(/^ (.+) $/, "$1") });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (ch === "!" && source[i + 1] === "[") {
      const link = bracketLink(source, i + 1);
      if (link) {
        flush();
        out.push({ type: "image", alt: link.text, url: link.url });
        i = link.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = bracketLink(source, i);
      if (link) {
        flush();
        // A link inside link words is only its words: no nested links.
        out.push({ type: "link", children: stripLinks(nested(link.text)), url: link.url, text: link.text });
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      const comment = COMMENT.exec(rest);
      const tag = comment ?? TAG.exec(rest);
      if (tag) {
        flush();
        out.push({ type: "html", text: tag[0] });
        i += tag[0].length;
        continue;
      }
      // `<https://…>` is an autolink in markdown. Here it is the address as
      // text, the same as a bare URL.
      const auto = /^<((?:https?:\/\/|www\.)[^\s<>]+)>/i.exec(rest);
      if (auto) {
        flush();
        out.push({ type: "url", text: auto[1]! });
        i += auto[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "H" || ch === "w" || ch === "W") && (i === 0 || /[\s(]/.test(source[i - 1]!))) {
      const url = BARE_URL.exec(rest);
      if (url) {
        flush();
        // Trailing sentence punctuation belongs to the sentence.
        const trimmed = url[0].replace(/[.,;:!?)\]'"]+$/, "");
        out.push({ type: "url", text: trimmed });
        i += trimmed.length;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const strong = source.startsWith(ch + ch, i) ? closing(source, i + 2, ch + ch) : -1;
      if (strong > i + 2) {
        flush();
        out.push({ type: "strong", children: nested(source.slice(i + 2, strong)) });
        i = strong + 2;
        continue;
      }
      // An underscore inside a word (snake_case) is not emphasis.
      const intraword = ch === "_" && i > 0 && /\w/.test(source[i - 1]!);
      const em = !intraword && source[i + 1] !== ch ? closing(source, i + 1, ch) : -1;
      if (em > i + 1 && !(ch === "_" && /\w/.test(source[em + 1] ?? ""))) {
        flush();
        out.push({ type: "em", children: nested(source.slice(i + 1, em)) });
        i = em + 1;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** The index of `marker` closing an emphasis run opened before `from`, on the same line. */
function closing(source: string, from: number, marker: string): number {
  if (/\s/.test(source[from] ?? " ")) return -1;
  let at = source.indexOf(marker, from);
  while (at !== -1) {
    const newline = source.indexOf("\n", from);
    if (newline !== -1 && newline < at) return -1;
    if (!/\s/.test(source[at - 1]!)) return at;
    at = source.indexOf(marker, at + marker.length);
  }
  return -1;
}

/** `[words](address "title")` starting at `open`, or `null`. */
function bracketLink(source: string, open: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let j = open; j < source.length && j < open + 1000; j++) {
    const c = source[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n" && source[j + 1] === "\n") return null;
    if (c === "[") depth++;
    if (c === "]" && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close === -1 || source[close + 1] !== "(") return null;
  const end = source.indexOf(")", close + 2);
  if (end === -1) return null;
  const target = source.slice(close + 2, end).trim();
  const url = target.replace(/\s+(?:"[^"]*"|'[^']*')$/, "").replace(/^<(.*)>$/, "$1");
  return { text: source.slice(open + 1, close), url, end: end + 1 };
}

function stripLinks(nodes: Inline[]): Inline[] {
  return nodes.map((node) => {
    if (node.type === "link") return { type: "text", text: node.text };
    if (node.type === "strong" || node.type === "em") return { ...node, children: stripLinks(node.children) };
    return node;
  });
}

/** The visible words of a run of inlines, for an accessible name. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
        case "html":
        case "url":
          return node.text;
        case "strong":
        case "em":
        case "link":
          return inlineText(node.children);
        case "image":
          return node.alt;
      }
    })
    .join("");
}
