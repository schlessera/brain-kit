/** The concrete opt-in policy for app exports; no configurable parser or callback. */
import { serialize, defaultTreeAdapter as tree, type DefaultTreeAdapterTypes as T } from "parse5";
import { attribute, isElement, leadingBom, parseDocument, parseHtmlFragment, textOf, type HtmlElement } from "./html.js";
import { classifyLink, classifyMailto, LINK_URL_MAX, refusalSentence } from "./links.js";

export type ExportLinkPolicy = "visible-destinations";
const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MATH = "http://www.w3.org/1998/Math/MathML";
const HOST = "data-brain-link-destination";
const LINK = "data-brain-export-link";
const WORDS = "data-brain-link-words";

function remove(el: HtmlElement) { tree.detachNode(el); }
function removeAttrs(el: HtmlElement, names: string[]) { el.attrs = el.attrs.filter((a) => !names.includes(a.name)); }
function set(el: HtmlElement, name: string, value: string) {
  removeAttrs(el, [name]); el.attrs.push({ name, value });
}
function element(markup: string): HtmlElement {
  return parseHtmlFragment(markup).childNodes.find(isElement)!;
}
function escape(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function appendText(el: HtmlElement, s: string) { tree.insertText(el, s); }
function after(el: HtmlElement, node: HtmlElement) {
  const parent = el.parentNode;
  if (!parent) return;
  const next = parent.childNodes[parent.childNodes.indexOf(el) + 1];
  if (next) tree.insertBefore(parent, node, next); else tree.appendChild(parent, node);
}
function* all(root: T.ParentNode): Generator<HtmlElement> {
  const stack = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    yield node;
    const children = node.tagName === "template" && "content" in node
      ? (node as T.Template).content.childNodes : node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** Preserve NULs before HTML's replacement-character normalization. */
function rawHref(el: HtmlElement, html: string, attr: HtmlElement["attrs"][number]): string {
  if (attr.value.length > LINK_URL_MAX) return attr.value;
  const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
  const loc = el.sourceCodeLocation?.attrs?.[name];
  if (!loc) return attr.value;
  const shift = leadingBom(html);
  const source = html.slice(loc.startOffset + shift, loc.endOffset + shift);
  const nulls = /\u0000|&#(?:x0+(?![0-9a-f])|0+(?![0-9]));?/gi;
  if (source.search(nulls) < 0) return attr.value;
  // Re-read the parser-located attribute with a collision-free stand-in.
  // Numeric references are decoded by parse5, not by a second entity parser.
  let index = 0;
  let marker: string;
  do { marker = `__brain_export_null_${index++}__`; } while (attr.value.includes(marker));
  const preserved = element(`<span ${source.replace(nulls, marker)}></span>`);
  return (attribute(preserved, name) ?? attr.value).replaceAll(marker, "\u0000");
}

/**
 * Apply after shell assembly, including complete/bare documents. HTML is
 * parsed as Chrome parses it with scripts disabled. A second application
 * rebuilds its labels from the current href, never trusts an input marker.
 */
export function applyExportLinkPolicy(html: string): string {
  const doc = parseDocument(html);
  // Flatten declarative shadow roots into ordinary markup. Their template
  // content is active in Chrome even with JavaScript disabled.
  for (const el of [...all(doc)]) {
    if (el.tagName !== "template" || !attribute(el, "shadowrootmode") || !("content" in el) || !el.parentNode) continue;
    for (const node of [...(el as T.Template).content.childNodes]) {
      tree.detachNode(node); tree.insertBefore(el.parentNode, node, el);
    }
    remove(el);
  }
  const nodes = [...all(doc)];
  for (const el of nodes) {
    removeAttrs(el, [LINK]);
    if (attribute(el, WORDS) !== undefined && el.parentNode) {
      for (const child of [...el.childNodes]) { tree.detachNode(child); tree.insertBefore(el.parentNode, child, el); }
      remove(el);
    }
    // Source-controlled markers cannot exempt a target from classification.
    if (attribute(el, HOST) !== undefined || (attribute(el, "class") ?? "").split(/\s+/).includes("bk-plink-host")) {
      const parent = el.parentNode;
      if (parent && isElement(parent) && parent.tagName === "a") {
        // Exact-text links use the protected node as their words. Keep those
        // words before rebuilding; a normal appended suffix is discarded.
        if (parent.childNodes.length === 1) {
          const text = tree.createTextNode(textOf(el));
          tree.insertBefore(parent, text, el);
        }
        remove(el);
      } else removeAttrs(el, [HOST]);
    }
    if (el.namespaceURI === HTML && (el.tagName === "base" || (el.tagName === "meta" && attribute(el, "http-equiv")?.toLowerCase() === "refresh"))) remove(el);
    // Embedded documents have their own annotation tree, base and CSS. They
    // are outside the static block vocabulary, so export them honestly inert.
    if (el.namespaceURI === HTML && ["iframe", "object", "embed"].includes(el.tagName)) {
      after(el, element('<span class="remote-image">[embedded document — not included]</span>')); remove(el);
    }
    removeAttrs(el, ["action", "formaction", "ping"]);
    if (el.namespaceURI === SVG && /^(?:set|animate|animateMotion|animateTransform)$/.test(el.tagName)
      && /^(?:xlink:)?href$/i.test(attribute(el, "attributeName") ?? "")) remove(el);
  }
  for (const el of [...all(doc)]) {
    const navigation = (el.namespaceURI === HTML && ["a", "area"].includes(el.tagName))
      || (el.namespaceURI === SVG && el.tagName === "a") || (el.namespaceURI === MATH && attribute(el, "href") !== undefined);
    if (!navigation) continue;
    // In SVG the unprefixed href takes precedence over xlink:href.
    const target = el.attrs.find((a) => a.name === "href" && !a.namespace) ?? el.attrs.find((a) => a.name === "href");
    const raw = target ? rawHref(el, html, target) : undefined;
    if (raw === undefined) continue;
    const autolink = attribute(el, "data-brain-export-autolink") !== undefined;
    removeAttrs(el, ["data-brain-export-autolink", "href", "target", "download", "rel", "referrerpolicy", "role", "tabindex"]);
    el.attrs = el.attrs.filter((a) => !a.name.startsWith("aria-"));
    let anchor = el;
    if (el.namespaceURI !== HTML || el.tagName === "area") {
      // SVG text/layout remain intact and inert. An ordinary caption alongside
      // the figure carries the same useful, disclosed destination in the PDF.
      let figure = el;
      while (figure.parentNode && isElement(figure.parentNode) && figure.parentNode.namespaceURI !== HTML) figure = figure.parentNode;
      if (figure.parentNode && isElement(figure.parentNode) && figure.parentNode.tagName === "a") figure = figure.parentNode;
      anchor = element("<a></a>");
      appendText(anchor, textOf(el) || attribute(el, "alt") || "Link");
      after(figure, anchor);
    }
    const verdict = /^mailto:/i.test(raw) ? classifyMailto(raw) : classifyLink(raw);
    if (raw.startsWith("#") && !verdict.ok && verdict.reason === "relative") {
      set(anchor, "href", raw); set(anchor, "rel", "noopener noreferrer nofollow"); set(anchor, "referrerpolicy", "no-referrer");
      continue;
    }
    if (!verdict.ok) {
      if (autolink || textOf(anchor) === raw || textOf(anchor) === target?.value) { anchor.childNodes = []; appendText(anchor, verdict.shown); }
      anchor.tagName = "span";
      appendText(anchor, ` [link withheld — ${refusalSentence(verdict)}]`);
      if (verdict.reason === "relative" && textOf(anchor) !== raw) appendText(anchor, ` [target: ${verdict.shown}]`);
      continue;
    }
    const destination = "display" in verdict ? verdict.display : verdict.host;
    const text = anchor.childNodes.length === 1 && anchor.childNodes[0].nodeName === "#text" ? textOf(anchor) : undefined;
    const redundant = "display" in verdict ? text === verdict.display
      : text === verdict.href || (verdict.path === "" && `${text}/` === verdict.href) || text === verdict.host;
    set(anchor, "href", verdict.href); set(anchor, LINK, "");
    set(anchor, "rel", "noopener noreferrer nofollow"); set(anchor, "referrerpolicy", "no-referrer");
    // Always retain a protected destination node, including an exact-text
    // autolink; otherwise supplied child CSS could hide the only disclosure.
    if (redundant) {
      anchor.childNodes = [];
      const label = element(`<code ${HOST}>${escape(text!)}</code>`);
      tree.appendChild(anchor, label);
    } else {
      // Keep author-supplied code/ARIA inside a separate paragraph tag in the
      // PDF. Only the final, renderer-owned Code child discloses the target.
      const words = element(`<span ${WORDS} role="paragraph"></span>`);
      for (const child of [...anchor.childNodes]) { tree.detachNode(child); tree.appendChild(words, child); }
      for (const child of all(words)) child.attrs = child.attrs.filter((a) => a.name !== "role" && !["aria-owns", "aria-labelledby"].includes(a.name));
      tree.appendChild(anchor, words);
      const labels = destination.split(".").map((s, i, parts) => `<span style="display:inline-block;width:max-content;max-width:100%;overflow-wrap:anywhere">${i === 0 ? "(" : ""}${escape(s)}${i === parts.length - 1 ? ")" : "."}</span>${i === parts.length - 1 ? "" : "<wbr>"}`).join("");
      tree.appendChild(anchor, element(`<code ${HOST}> ${labels}</code>`));
    }
  }
  // A template that stays inert is not a policy escape hatch if a caller later
  // activates it: its links were visited too. Its local href cannot use a base.
  return serialize(doc);
}

/**
 * Trusted browser-side finishing step, serializable through page.evaluate.
 * Only the renderer invokes it, after applyExportLinkPolicy and in the final
 * media mode. Document scripts stay disabled. CSS that clips a disclosure is
 * repaired locally; if any glyph still cannot be drawn, fail the export.
 */
export async function protectExportLinkDestinations(maxCaptureHeight?: number): Promise<void> {
  const anchors = document.querySelectorAll<HTMLAnchorElement>("a[data-brain-export-link]");
  if (anchors.length === 0) return;
  const force = (el: HTMLElement, props: Record<string, string>) => {
    // Parse a complete declaration list with our values last. Updating an
    // existing CSSOM longhand may retain its position before an `all` reset.
    el.style.cssText += ";" + Object.entries(props).map(([name, value]) => `${name}:${value}!important`).join(";");
  };
  // Freeze the static export. Making hit testing available also catches a
  // painted overlay whose author disabled pointer events to conceal it.
  for (const el of document.querySelectorAll<HTMLElement>("*")) {
    if (el.style) force(el, { "pointer-events": "auto", animation: "none", transition: "none" });
  }
  for (const svg of document.querySelectorAll("svg")) svg.pauseAnimations();
  await document.fonts.ready;
  const stylesheet = document.createElement("style");
  // A caller must not reopen our first layer with a more specific rule.
  const layer = "brain-export-" + [...crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(16).padStart(8, "0")).join("");
  stylesheet.style.cssText = "display:none!important";
  // First-layer !important declarations precede supplied layers/unlayered
  // rules; pseudo-content cannot be reset by an inline style attribute.
  stylesheet.textContent = `@layer ${layer}{*,*::before,*::after{animation:none!important;transition:none!important;pointer-events:auto!important}[data-brain-export-link]::before,[data-brain-export-link]::after,[data-brain-link-destination]::before,[data-brain-link-destination]::after,[data-brain-link-destination] *::before,[data-brain-link-destination] *::after{content:none!important;display:none!important}}`;
  document.head.prepend(stylesheet);
  if (!stylesheet.sheet?.cssRules.length) throw new Error("Export link destination protection stylesheet is blocked");
  for (const anchor of anchors) {
    anchor.setAttribute("role", "link");
    const destination = anchor.querySelector<HTMLElement>("[data-brain-link-destination]");
    if (!destination) throw new Error("Export link has no visible destination");
    const safe = { "mix-blend-mode": "normal", "backdrop-filter": "none", animation: "none", transition: "none", opacity: "1", visibility: "visible", filter: "none", "clip-path": "none", mask: "none", "content-visibility": "visible" };
    const display = getComputedStyle(anchor).display;
    destination.removeAttribute("style");
    force(anchor, { ...safe, "-webkit-text-fill-color": "currentcolor", "letter-spacing": "normal", "text-indent": "0px", display: display === "inline" || display === "none" ? "inline-block" : display, position: "static", transform: "none", "break-inside": "avoid", "box-sizing": "border-box", "white-space": "normal", "text-overflow": "clip", overflow: "visible", height: "auto", "max-height": "none", "max-width": "100%" });
    force(destination, { all: "revert", ...safe, display: "inline", "font-family": "monospace", "font-size": "max(12px, .8em)", "font-weight": "500", "line-height": "1.6", color: "#595650", "-webkit-text-fill-color": "#595650", "-webkit-text-stroke-width": "0px", "text-shadow": "none", "text-indent": "0px", "letter-spacing": "normal", "word-spacing": "normal", "writing-mode": "horizontal-tb", transform: "none", background: "#ffffff", "white-space": "normal", "overflow-wrap": "anywhere", "text-decoration": "none", position: "relative", "z-index": "2147483647", "unicode-bidi": "isolate", direction: "ltr" });
    for (const child of destination.querySelectorAll<HTMLElement>("span")) {
      // Updating an existing longhand keeps its old declaration order. Clear
      // our owned inline styles so the reset precedes every protected value.
      child.removeAttribute("style");
      force(child, { all: "revert", ...safe, display: "inline-block", width: "max-content", "max-width": "100%", "overflow-wrap": "anywhere", "font-family": "inherit", "font-size": "inherit", color: "inherit", "-webkit-text-fill-color": "inherit", "-webkit-text-stroke-width": "0px", background: "inherit", "white-space": "normal" });
    }
    // A suffix must not be clipped by the link's surrounding card or supplied
    // fixed-height/hidden container. Preserve the normal layout properties.
    for (let ancestor = anchor.parentElement; ancestor; ancestor = ancestor.parentElement) {
      force(ancestor, { ...safe, clip: "auto", contain: "none", "text-overflow": "clip" });
      const css = getComputedStyle(ancestor);
      if (css.display === "none") force(ancestor, { display: "block" });
      const bounds = ancestor.getBoundingClientRect();
      const disclosure = destination.getBoundingClientRect();
      const outside = disclosure.left < bounds.left || disclosure.right > bounds.right + 1 || disclosure.top < bounds.top || disclosure.bottom > bounds.bottom + 1;
      if (outside) force(ancestor, { overflow: "visible", height: "auto", "max-height": "none" });
      if (ancestor === document.body || ancestor === document.documentElement) force(ancestor, { height: "auto" });
      if (parseFloat(css.width) < 12 || parseFloat(css.maxWidth) < 12) force(ancestor, { width: "auto", "max-width": "none" });
    }
    const walker = document.createTreeWalker(destination, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.parentElement?.tagName === "STYLE") continue;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text.data[i])) continue;
        range.setStart(text, i); range.setEnd(text, i + 1);
        let rect = range.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > innerHeight) {
          window.scrollTo(0, scrollY + rect.top - innerHeight / 2);
          rect = range.getBoundingClientRect();
        }
        if (rect.width < 1 || rect.height < 1 || rect.left < 0 || rect.right > innerWidth + 1) throw new Error("Export link destination is clipped");
        if (maxCaptureHeight !== undefined) {
          const body = document.body.getBoundingClientRect();
          if (rect.top < body.top || rect.bottom > body.top + Math.min(body.height, maxCaptureHeight)) throw new Error("Export link destination exceeds PNG capture bounds");
        }
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!top || !destination.contains(top)) throw new Error("Export link destination is obscured");
      }
    }
  }
  window.scrollTo(0, 0);
}
