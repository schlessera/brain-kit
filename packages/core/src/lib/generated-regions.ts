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

/** Where the region's markers sit in `body`, or null when it has none. */
function locate(body: string, name: string): { start: number; end: number; inner: [number, number] } | null {
  const { open, close } = markers(name);
  const start = body.indexOf(open);
  if (start === -1) return null;
  const closeAt = body.indexOf(close, start + open.length);
  if (closeAt === -1) return null;
  return { start, end: closeAt + close.length, inner: [start + open.length, closeAt] };
}

/** The region's content, without the blank lines around it; null when `body` has no such region. */
export function readGeneratedRegion(body: string, name: string): string | null {
  const at = locate(body, name);
  if (!at) return null;
  return body.slice(at.inner[0], at.inner[1]).replace(/^\s*\n/, "").replace(/\n\s*$/, "");
}

/**
 * `body` with the region's content replaced by `content`, every byte outside
 * the markers kept. A body without the region gets it appended at the end.
 * Returns `body` itself when the content is already `content`.
 */
export function replaceGeneratedRegion(body: string, name: string, content: string): string {
  const { open, close } = markers(name);
  const block = `${open}\n\n${content}\n\n${close}`;
  const at = locate(body, name);
  if (!at) return `${body.trimEnd()}\n\n${block}\n`;
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
 * already current: the caller writes nothing.
 */
export function rewriteGeneratedRegion(raw: string, name: string, content: string, asOf: string): string | null {
  const { frontmatter, body } = splitFrontmatterBlock(raw);
  const next = replaceGeneratedRegion(body, name, content);
  if (next === body) return null;
  return `${frontmatter.replace(/^updated:.*$/m, `updated: ${asOf}`)}${next}`;
}
