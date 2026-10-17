/** Closed CommonMark fences, including offsets needed to preserve surrounding source. */
export interface ContentFence {
  start: number;
  end: number;
  source: string;
  indent: string;
  language: string;
}
const fenceLine = /^( {0,3})(`{3,}|~{3,})(.*)$/;

export function findContentFences(markdown: string): ContentFence[] {
  const fences: ContentFence[] = [];
  let offset = 0;
  let open: { char: string; length: number; start: number; contentStart: number; indent: string; language: string } | undefined;
  for (const line of markdown.split("\n")) {
    const end = Math.min(offset + line.length + 1, markdown.length);
    const match = fenceLine.exec(line);
    if (open) {
      if (match && match[2][0] === open.char && match[2].length >= open.length && match[3].trim() === "") {
        fences.push({ start: open.start, end, source: markdown.slice(open.contentStart, offset).replace(/\n$/, ""), indent: open.indent, language: open.language });
        open = undefined;
      }
    } else if (match && !(match[2][0] === "`" && match[3].includes("`"))) {
      open = { char: match[2][0], length: match[2].length, start: offset, contentStart: end,
        indent: match[1], language: match[3].trim().split(/\s+/)[0] ?? "" };
    }
    offset += line.length + 1;
  }
  return fences;
}
