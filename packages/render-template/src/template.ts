import { marked } from "marked";

import {
  attribute,
  childElements,
  documentParts,
  elements,
  leadingBom,
  parseDocument,
  parseHtmlFragment,
  startsAsDocument,
  textOf,
  titleElement,
} from "./html.js";
import { pageFooter, STYLES } from "./styles.js";

marked.setOptions({ gfm: true, breaks: false });

/** What `content` holds — markdown to parse, or HTML to pass through. */
export type RenderContentType = "markdown" | "html";

/** The title a document gets when neither the caller nor the content names one. */
export const DEFAULT_TITLE = "Shared from Brain";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The renderer denies the page all network access by default (see
 * @schlessera/brain-render-puppeteer), so a remote `<img>` would silently render
 * as a broken-image box. Replace those with a visible, honest placeholder —
 * inlined `data:` images still render normally.
 *
 * `allowHosts` mirrors the renderer's own host allowlist: an image whose host
 * the renderer will actually resolve is left alone. Passing hosts here without
 * passing the same list to the renderer produces broken images, not
 * placeholders — the two lists belong together.
 */
function placeholderRemoteImages(html: string, allowHosts: string[], full: boolean): string {
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()));
  // Real <img> elements only, as the parser sees them: one inside an
  // attribute value, a comment or a <textarea> is text and stays text. The
  // parser also decodes the src, so `data&#58;` is inline data.
  const root = full ? parseDocument(html) : parseHtmlFragment(html);
  const shift = leadingBom(html);
  const out: string[] = [];
  let copied = 0;
  for (const el of elements(root)) {
    if (el.tagName !== "img" || el.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    const loc = el.sourceCodeLocation;
    const value = attribute(el, "src");
    if (!loc || !value || /^\s*data:/i.test(value)) continue;
    const host = hostOf(value.trim());
    if (host && allowed.has(host)) continue;
    const label = attribute(el, "alt");
    out.push(
      html.slice(copied, loc.startOffset + shift),
      `<span class="remote-image">[${label ? escapeHtml(label) : "remote image"} — not embedded]</span>`
    );
    copied = loc.endOffset + shift;
  }
  if (copied === 0) return html;
  out.push(html.slice(copied));
  return out.join("");
}

/**
 * Whether `html` is a complete document rather than a fragment: after a BOM,
 * whitespace and comments it opens with a doctype or an `<html>` tag.
 */
export function isFullDocument(html: string): boolean {
  return startsAsDocument(html);
}

/**
 * Inject the shell into a complete document instead of nesting it (#530): the
 * stylesheet becomes the first child of its `<head>`, so every rule the author
 * wrote comes later and, being outside `@layer brain-document`, wins. Its own
 * `<title>` stands; `title` only fills one in when there is none.
 * `<meta name="brain-render" content="bare">` in its head leaves it as it is.
 */
function injectShell(doc: string, title: string | undefined, runningTitle: string | false | undefined): string {
  const parsed = parseDocument(doc);
  const shift = leadingBom(doc);
  const { html, head, doctype } = documentParts(parsed);
  const inHead = head ? childElements(head) : [];
  const bare = inHead.some(
    (e) =>
      e.tagName === "meta" &&
      attribute(e, "name")?.toLowerCase() === "brain-render" &&
      attribute(e, "content")?.trim().toLowerCase() === "bare"
  );
  if (bare) return doc;
  const titleEl = titleElement(parsed);
  const own = titleEl ? textOf(titleEl).trim() || undefined : undefined;
  const running = runningTitle === false ? undefined : (runningTitle ?? own ?? title);
  const insert =
    `<style>${STYLES}${pageFooter(running === DEFAULT_TITLE ? undefined : running)}</style>` +
    (!titleEl && title ? `<title>${escapeHtml(title)}</title>` : "");
  // An element the parser opened by itself has no location; only a tag the
  // author wrote is a place to insert after.
  const headTag = head?.sourceCodeLocation?.startTag;
  if (headTag) return splice(doc, headTag.endOffset + shift, insert);
  const htmlTag = html?.sourceCodeLocation?.startTag;
  if (htmlTag) return splice(doc, htmlTag.endOffset + shift, `<head>${insert}</head>`);
  // A doctype with no <html> tag: the parser opens html and head itself, and a
  // <style> straight after the doctype lands in that head.
  return splice(doc, (doctype?.sourceCodeLocation?.endOffset ?? 0) + shift, insert);
}

function splice(doc: string, at: number, insert: string): string {
  return doc.slice(0, at) + insert + doc.slice(at);
}

export interface BuildHtmlDocumentOptions {
  content: string;
  contentType: RenderContentType;
  /**
   * `<title>` for markdown and fragments, default "Shared from Brain". A
   * complete HTML document keeps its own; this only fills one in if it has none.
   */
  title?: string;
  /**
   * Image hosts the renderer has been told to resolve. Images on these hosts
   * survive; every other remote image becomes a placeholder. Default: none.
   */
  allowHosts?: string[];
  /**
   * The title in the PDF footer, from page 2 on. Default: the document's
   * title, unless that is the "Shared from Brain" fallback. `false` shows the
   * page numbers alone.
   */
  runningTitle?: string | false;
}

/**
 * Wrap markdown or HTML in the shared print-ready document shell.
 *
 * A complete HTML document (`<!doctype html>` or `<html>` first) is not
 * wrapped: the stylesheet is injected into its `<head>` instead, and
 * `<meta name="brain-render" content="bare">` skips even that.
 *
 * The same function backs the UI's `/api/render` and the CLI's `brain render`,
 * so a page shared from the app and a PDF produced on the command line are
 * byte-identical for identical input.
 */
export function buildHtmlDocument(opts: BuildHtmlDocumentOptions): string {
  const allowHosts = opts.allowHosts ?? [];
  if (opts.contentType === "html" && isFullDocument(opts.content)) {
    return injectShell(placeholderRemoteImages(opts.content, allowHosts, true), opts.title, opts.runningTitle);
  }
  const rendered =
    opts.contentType === "markdown"
      ? (marked.parse(opts.content, { async: false }) as string)
      : opts.content;
  const inner = placeholderRemoteImages(rendered, allowHosts, false);
  const title = opts.title ?? DEFAULT_TITLE;
  const running = opts.runningTitle === false ? undefined : (opts.runningTitle ?? title);
  const footer = pageFooter(running === DEFAULT_TITLE ? undefined : running);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}${footer}</style>
</head>
<body>${inner}</body>
</html>`;
}

/**
 * A document's title as the browser reads it, decoded, or undefined when it
 * has none. An `<svg>`'s `<title>` is not the document's.
 */
export function documentTitle(html: string): string | undefined {
  const title = titleElement(parseDocument(html));
  return title ? textOf(title).trim() || undefined : undefined;
}
