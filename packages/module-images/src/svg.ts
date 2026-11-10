/**
 * The static-SVG check for GPT Image 2.6 `output_format: "svg"` (#3784).
 *
 * OpenAI's image-generation guide says authored SVG is static: no scripts,
 * no external resources, no embedded raster images. That is a vendor claim
 * about model output, not a guarantee, and an SVG opened from the brain runs
 * whatever it carries. So the text is checked before anything is written,
 * and anything that could run code or fetch from elsewhere is refused.
 *
 * The check is deliberately textual and conservative: it scans the whole
 * document, CDATA, comments and text included. A false positive refuses one
 * picture with a reason; a false negative would write active content into
 * the brain. `lintDocument` in render-template covers scripts and fetching
 * elements for local markdown SVGs, but not event handlers, `foreignObject`
 * or links, and this module does not depend on it.
 */

/** What makes an SVG not static, each with the reason shown to the user. */
const ACTIVE: [RegExp, string][] = [
  [/<!DOCTYPE|<!ENTITY/i, "a DOCTYPE or entity declaration"],
  [/<\s*(?:[a-z][\w.-]*:)?script\b/i, "a <script> element"],
  [/<\s*(?:[a-z][\w.-]*:)?foreignObject\b/i, "a <foreignObject> element"],
  [/<\s*(?:[a-z][\w.-]*:)?(?:iframe|object|embed|audio|video|handler|listener)\b/i, "an embedding or handler element"],
  // An attribute named on*: whitespace, then the name, then `=`.
  [/[\s"'/]on[a-z][\w.-]*\s*=/i, "an event-handler attribute"],
  // Any link that is not a same-document fragment: external, data: (an
  // embedded raster) and javascript: alike.
  [/(?:^|[\s"'])(?:[a-z][\w.-]*:)?(?:href|src)\s*=\s*(?!["']\s*#)/i, "a reference outside the document"],
  [/url\(\s*(?!["']?\s*#)/i, "a url() reference outside the document"],
  [/@import\b/i, "a stylesheet @import"],
];

/** Why `text` is not a static SVG, or `undefined` when it is one. */
export function staticSvgProblem(text: string): string | undefined {
  const start = text.replace(/^﻿/, "").trimStart().replace(/^<\?xml[^>]*\?>\s*/i, "");
  if (!/^<\s*svg[\s>]/i.test(start)) return "it is not an SVG document";
  for (const [pattern, what] of ACTIVE) {
    if (pattern.test(text)) return `it contains ${what}`;
  }
  return undefined;
}
