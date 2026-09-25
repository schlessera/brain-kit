/**
 * The links a markdown file makes and the anchors it exposes to a `#fragment`
 * link, read from the parsed document as GitHub renders it.
 *
 * tests/docs-paths.test.ts uses these to check that a relative link resolves
 * and that a link such as
 * `docs/extending/README.md#promoting-a-community-provider-to-a-built-in`
 * still names a heading after the heading is edited. Both come from the
 * markdown syntax tree rather than from regular expressions over the text: a
 * regex cannot tell a link from Overpass QL in a code span
 * (`way["natural"="coastline"](bbox)`), a heading from a comment in a tilde
 * fence, or a reference-style link from prose. It lives in its own module (not
 * exported from a .test.ts file) so its unit tests can import it without
 * re-registering the link gate.
 */

import GithubSlugger from "github-slugger";
import type { Html, Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const MARKDOWN = unified().use(remarkParse).use(remarkGfm);

/**
 * A YAML front-matter block, which GitHub renders as a table. Left in, its
 * closing `---` reads as a setext underline and invents a heading. It opens
 * on the file's first line and closes on the next `---` line, which may be
 * the very next one or the last line of the file.
 */
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/;

function parse(body: string): Root {
  return MARKDOWN.parse(body.replace(FRONT_MATTER, ""));
}

function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}

/**
 * The destination of every link and image as GitHub renders it, plus every
 * link reference definition that nothing uses. A reference (`[x][ref]`,
 * `[ref]`) takes the first definition of its label, as GFM does; a later
 * duplicate never renders, so it is not returned. An unused definition does
 * not render either, but it is returned on purpose: it is still a line in
 * the doc naming a target, and the next edit that uses it inherits the break.
 * Code spans, fenced and indented code, and HTML are never links, so nothing
 * inside them is returned.
 */
export function markdownLinks(body: string): string[] {
  const tree = parse(body);
  const definitions = new Map<string, string>();
  walk(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  const urls: string[] = [];
  const used = new Set<string>();
  walk(tree, (node) => {
    if (node.type === "link" || node.type === "image") urls.push(node.url);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const url = definitions.get(node.identifier);
      if (url !== undefined) {
        urls.push(url);
        used.add(node.identifier);
      }
    }
  });
  for (const [identifier, url] of definitions) if (!used.has(identifier)) urls.push(url);
  return urls;
}

/**
 * A link destination split at its first `#` and percent-decoded, the way a
 * browser resolves it. A malformed escape (`#100%`) is reported, not thrown,
 * so one bad link names itself instead of aborting the whole check.
 */
export function splitLink(
  url: string,
): { path: string; fragment: string | null } | { error: string } {
  const hash = url.indexOf("#");
  const rawPath = hash === -1 ? url : url.slice(0, hash);
  const rawFragment = hash === -1 ? null : url.slice(hash + 1);
  try {
    return {
      path: decodeURIComponent(rawPath),
      fragment: rawFragment === null ? null : decodeURIComponent(rawFragment),
    };
  } catch {
    return { error: `malformed percent-escape in ${url}` };
  }
}

/** Every `<a>` tag's `id` or `name` value, from HTML outside comments. */
function explicitAnchors(node: Html): string[] {
  const html = node.value.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const found: string[] = [];
  for (const tag of html.matchAll(/<a\s[^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      found.push(attr[1] ?? attr[2] ?? attr[3]);
    }
  }
  return found;
}

/**
 * Every anchor in a markdown body: one GitHub slug per heading (ATX or setext,
 * at any depth, numbered `-1`, `-2` around every slug already taken), plus the
 * `id` / `name` of each `<a>` tag. A heading's slug is taken from its rendered
 * text, so inline HTML tags and emphasis markers do not reach it. Code and
 * HTML comments render neither headings nor anchors, so they add nothing.
 */
export function markdownAnchors(body: string): Set<string> {
  const anchors = new Set<string>();
  const slugger = new GithubSlugger();
  walk(parse(body), (node) => {
    if (node.type === "heading") {
      anchors.add(slugger.slug(toString(node, { includeHtml: false })));
    } else if (node.type === "html") {
      for (const anchor of explicitAnchors(node)) anchors.add(anchor);
    }
  });
  return anchors;
}
