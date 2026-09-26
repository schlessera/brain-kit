/**
 * Generated regions: the one way core and its modules keep a derived view
 * inside a hand-written markdown file.
 *
 *     <!-- brain:generated:{name} -->
 *
 *     …generated content…
 *
 *     <!-- /brain:generated:{name} -->
 *
 * Everything outside the markers belongs to the person who wrote the file and
 * is never touched. A region is rewritten only when its content changed, so a
 * run with nothing new writes nothing and leaves no diff. `brain registry`
 * renders `_index.md` registry tables this way, and module-finance its ledger
 * and dashboard tables.
 */

/** A region name: lowercase letters, digits and dashes. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

function markers(name: string): { open: string; close: string } {
  if (!NAME.test(name)) throw new Error(`invalid generated-region name: ${JSON.stringify(name)}`);
  return { open: `<!-- brain:generated:${name} -->`, close: `<!-- /brain:generated:${name} -->` };
}

/** The line ending a body uses: CRLF when it has one, else LF. */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Where the region's markers sit in `body`, or null when it has none. A marker
 * counts only on a line of its own (surrounding spaces and tabs allowed), so a
 * marker quoted in a table cell or a sentence is text. One opening line
 * followed by one closing line is a region; any other combination (a stray
 * marker, two of either, the closing one first) throws, and the caller leaves
 * the file alone rather than guess which part is generated.
 */
function locate(body: string, name: string): { start: number; end: number; inner: [number, number] } | null {
  const { open, close } = markers(name);
  const opens: number[] = [];
  const closes: number[] = [];
  let offset = 0;
  for (const line of body.split("\n")) {
    const text = line.replace(/\r$/, "").trim();
    const at = offset + line.indexOf(text);
    if (text === open) opens.push(at);
    else if (text === close) closes.push(at);
    offset += line.length + 1;
  }
  if (opens.length === 0 && closes.length === 0) return null;
  if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) {
    throw new Error(
      `generated region "${name}" has malformed markers: ${opens.length} opening and ${closes.length} closing line(s)`
    );
  }
  const [start, closeAt] = [opens[0], closes[0]];
  return { start, end: closeAt + close.length, inner: [start + open.length, closeAt] };
}

/**
 * The region's content, without the blank lines around it and with LF line
 * endings; null when `body` has no such region. Throws on malformed markers.
 */
export function readGeneratedRegion(body: string, name: string): string | null {
  const at = locate(body, name);
  if (!at) return null;
  return body
    .slice(at.inner[0], at.inner[1])
    .replace(/\r\n/g, "\n")
    .replace(/^\s*\n/, "")
    .replace(/\n\s*$/, "");
}

/**
 * `body` with the region's content replaced by `content`, every byte outside
 * the markers kept. A body without the region gets it appended at the end,
 * after only the line breaks needed to make it a block of its own, in the
 * body's line ending; an existing region keeps its opening line's. Returns `body` itself when the content is
 * already `content`. Throws on malformed markers.
 */
export function replaceGeneratedRegion(body: string, name: string, content: string): string {
  const { open, close } = markers(name);
  const at = locate(body, name);
  // An existing region keeps the line ending of its opening line; a new one takes the body's.
  const eol = at ? (/^[^\n]*\r\n/.test(body.slice(at.inner[0])) ? "\r\n" : "\n") : eolOf(body);
  const block = [open, "", content.replace(/\r?\n/g, eol), "", close].join(eol);
  if (!at) {
    const gap = body === "" || body.endsWith(eol + eol) ? "" : body.endsWith(eol) ? eol : eol + eol;
    return `${body}${gap}${block}${eol}`;
  }
  if (body.slice(at.start, at.end) === block) return body;
  return body.slice(0, at.start) + block + body.slice(at.end);
}

/**
 * Split a file into its frontmatter block, kept verbatim (`---` fences
 * included), and its body. Frontmatter is never re-serialized: hand-written
 * YAML keeps its layout.
 */
export function splitFrontmatterBlock(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n[\s\S]*)?$/);
  if (!m) return { frontmatter: "", body: raw };
  return { frontmatter: m[1], body: m[2] ?? "" };
}

/**
 * A whole file with one region replaced and, only if that changed the file,
 * its `updated:` frontmatter line set to `asOf`. Null when the region is
 * already current: the caller writes nothing. Throws on malformed markers.
 */
export function rewriteGeneratedRegion(raw: string, name: string, content: string, asOf: string): string | null {
  const { frontmatter, body } = splitFrontmatterBlock(raw);
  const next = replaceGeneratedRegion(body, name, content);
  if (next === body) return null;
  return `${frontmatter.replace(/^updated:.*$/m, `updated: ${asOf}`)}${next}`;
}
