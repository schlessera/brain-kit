/**
 * HTML reading for the shell, done by parse5, the WHATWG parser: finding a
 * document's `<head>`, its title and its `bare` switch, replacing its remote
 * images, and walking its elements for the lint. A hand-written tokenizer
 * came first and three review passes kept finding inputs it read differently
 * from Chrome (comments, raw text, foreign content, entities). parse5 reads
 * them as the spec does, in linear time, and gives every element its offsets
 * in the source, so the shell can edit the author's bytes rather than
 * re-serialising them.
 */
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/**
 * Locations on, and scripting off: the renderer runs no JavaScript, so
 * `<noscript>` content is markup, as Chrome draws it.
 */
const OPTIONS = { sourceCodeLocationInfo: true, scriptingEnabled: false } as const;

/**
 * A leading byte-order mark is an encoding signal the browser strips before
 * parsing, but parse5, given a string, would read it as text and imply every
 * tag after it. Callers parse `html.slice(bom)` and add `bom` to offsets.
 */
export function leadingBom(html: string): number {
  return html.charCodeAt(0) === 0xfeff ? 1 : 0;
}

export function parseDocument(html: string): DefaultTreeAdapterTypes.Document {
  return parse(html.slice(leadingBom(html)), OPTIONS);
}

export function parseHtmlFragment(html: string): DefaultTreeAdapterTypes.DocumentFragment {
  return parseFragment(html.slice(leadingBom(html)), OPTIONS);
}

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * A document's title element as the browser picks it: the first HTML
 * `<title>` in tree order, wherever the parser put it. An `<svg>`'s title is
 * in another namespace and does not count.
 */
export function titleElement(root: ParentNode): HtmlElement | undefined {
  for (const el of elements(root)) if (el.tagName === "title" && el.namespaceURI === HTML_NS) return el;
  return undefined;
}

export function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

/** The HTML-namespace element children of `parent`. */
export function childElements(parent: ParentNode): HtmlElement[] {
  return parent.childNodes.filter(isElement);
}

/**
 * Every element under `root`, in document order. A `<template>`'s content is
 * not among its children, so nothing inert is visited.
 */
export function* elements(root: ParentNode): Generator<HtmlElement> {
  const stack: HtmlNode[] = [...root.childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    yield node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
}

/** An attribute's value, decoded, or undefined. */
export function attribute(el: HtmlElement, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

/** The element's class list. */
export function classList(el: HtmlElement): string[] {
  return (attribute(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** The text an element holds, decoded. */
export function textOf(el: ParentNode): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeName === "#text") text += (node as DefaultTreeAdapterTypes.TextNode).value;
    else if (isElement(node)) text += textOf(node);
  }
  return text;
}

/** A parsed document's `<html>`, `<head>` and `<body>`, which the parser always creates. */
export interface DocumentParts {
  html?: HtmlElement;
  head?: HtmlElement;
  body?: HtmlElement;
  doctype?: DefaultTreeAdapterTypes.ChildNode;
}

export function documentParts(doc: DefaultTreeAdapterTypes.Document): DocumentParts {
  const html = childElements(doc).find((e) => e.tagName === "html");
  const parts = html ? childElements(html) : [];
  return {
    html,
    head: parts.find((e) => e.tagName === "head"),
    body: parts.find((e) => e.tagName === "body"),
    doctype: doc.childNodes.find((n) => n.nodeName === "#documentType"),
  };
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/**
 * Whether `html` starts, after a BOM, whitespace and comments, with a doctype
 * or an `<html>` tag.
 */
export function startsAsDocument(html: string): boolean {
  let i = 0;
  for (;;) {
    while (i < html.length && (isSpace(html.charCodeAt(i)) || html.charCodeAt(i) === 0xfeff)) i++;
    if (!html.startsWith("<!--", i)) break;
    const end = html.indexOf("-->", i + 4);
    if (end < 0) return false;
    i = end + 3;
  }
  const head = /<(?:!doctype[\t\n\f\r ]+html\b|html\b)/iy;
  head.lastIndex = i;
  return head.test(html);
}

/**
 * How many things a piece of CSS would fetch: each `@import`, and each `url()`
 * that is not inline data or a same-document `#fragment`. Comments and string
 * literals are skipped, a `url()`'s own quoted argument is consumed whole, and
 * each character is read once.
 */
export function cssFetches(css: string): number {
  let count = 0;
  let i = 0;
  const n = css.length;
  /** The offset just past the string that starts at `from`. */
  const skipString = (from: number): number => {
    const quote = css[from];
    let j = from + 1;
    while (j < n && css[j] !== quote && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  while (i < n) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
    } else if (c === '"' || c === "'") {
      i = skipString(i);
    } else if (c === "@" && /^@import\b/i.test(css.slice(i, i + 8))) {
      count++;
      i += 7;
    } else if ((c === "u" || c === "U") && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? "")) {
      let j = i + 4;
      while (j < n && isSpace(css.charCodeAt(j))) j++;
      const quoted = css[j] === '"' || css[j] === "'";
      const value = css.slice(quoted ? j + 1 : j, (quoted ? j + 1 : j) + 5);
      if (!/^(?:data:|#)/i.test(value)) count++;
      i = quoted ? skipString(j) : j;
    } else {
      i++;
    }
  }
  return count;
}
