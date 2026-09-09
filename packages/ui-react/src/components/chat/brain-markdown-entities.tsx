import React from "react";
import { renderBarePathsInText } from "./brain-markdown-links.js";

const ENTITY_TAGS: Record<string, string> = {
  co: "entity-co",
  p: "entity-p",
  proj: "entity-proj",
  ev: "entity-ev",
  d: "entity-d",
  st: "entity-st",
  f: "entity-f",
};

// Use a unicode marker that won't appear in normal text to wrap entities
// so they survive markdown parsing without relying on rehypeRaw
const ENTITY_START = "\u200B\u200B"; // zero-width spaces as delimiter
const ENTITY_SEP = "\u200B";
const ENTITY_END = "\u200B\u200B\u200B";

export function renderEntityTags(md: string): string {
  // Convert entity tags to marker-based format:
  //   START tag SEP content END  (START/SEP/END are ZWSP runs, see above)
  let result = md.replace(
    /<(co|p|proj|ev|d|st|f)>([\s\S]*?)<\/\1>/g,
    (_match, tag, content) => `${ENTITY_START}${tag}${ENTITY_SEP}${content}${ENTITY_END}`
  );
  // Clean up any orphaned/unmatched entity tags
  result = result.replace(/<\/?(?:co|p|proj|ev|d|st|f)>/g, "");

  // Log and strip any remaining non-standard HTML-like tags the LLM may have output
  result = result.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => {
    const allowed = [
      "span", "strong", "em", "b", "i", "a", "br", "hr", "p",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "code", "pre", "blockquote",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "img", "del", "sup", "sub",
    ];
    if (allowed.includes(tag.toLowerCase())) return match;
    console.warn("[entity-tags] Stripping unrecognized tag:", match);
    return "";
  });

  return result;
}

/**
 * Parse entity markers in a text string. Each entity content is run through
 * `innerTransform` so file-path linkification (or any other inline transform)
 * applies inside `<f>...</f>` spans too.
 */
export function renderEntitiesInText(
  text: string,
  innerTransform: (s: string) => React.ReactNode = (s) => s
): React.ReactNode[] {
  const pattern = new RegExp(
    `${ENTITY_START}(co|p|proj|ev|d|st|f)${ENTITY_SEP}(.*?)${ENTITY_END}`,
    "g"
  );
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(innerTransform(text.slice(lastIndex, match.index)));
    }
    const cls = ENTITY_TAGS[match[1]] || "";
    nodes.push(
      <span key={key++} className={cls}>
        {innerTransform(match[2])}
      </span>
    );
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(innerTransform(text.slice(lastIndex)));
  }
  return nodes;
}
/** Process a text string for entity markers and/or bare file paths. */
function transformTextString(
  text: string,
  opts: { entityTags: boolean; fileLinks: boolean }
): React.ReactNode {
  const linkify = opts.fileLinks
    ? (s: string): React.ReactNode => {
        if (!s) return s;
        const parts = renderBarePathsInText(s);
        if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
        return <>{parts}</>;
      }
    : (s: string): React.ReactNode => s;

  if (opts.entityTags && text.includes(ENTITY_START)) {
    return <>{renderEntitiesInText(text, opts.fileLinks ? (s) => linkify(s) : undefined)}</>;
  }

  return linkify(text);
}

/** Recursively process React children to expand entity markers / file paths in text nodes */
export function processChildText(children: React.ReactNode, opts: { entityTags: boolean; fileLinks: boolean }): React.ReactNode {
  if (typeof children === "string") {
    return transformTextString(children, opts);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      typeof child === "string"
        ? <React.Fragment key={i}>{transformTextString(child, opts)}</React.Fragment>
        : child
    );
  }
  return children;
}
