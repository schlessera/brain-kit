/**
 * What a pill label may be (#1004): a few plain words, at most
 * {@link LABEL_MAX_CHARS} characters, with no quotes and no trailing
 * punctuation. A small model's answer is cleaned into that shape here, or
 * refused, so a pill never prints a preamble, a quoted sentence or nothing.
 */

import { PILL_LABEL_MAX_CHARS } from "@schlessera/brain-ui-sdk/protocol";

/** The longest label a pill is given: the SDK's bound. */
export const LABEL_MAX_CHARS = PILL_LABEL_MAX_CHARS;
/** The most words a label keeps; the model is asked for two to four. */
export const LABEL_MAX_WORDS = 4;

// C0/C1 controls, zero-width and bidirectional formatting characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const QUOTES = /["'`‘’‚‛“”„‟«»‹›]/g;
// Markdown emphasis and list or heading markers a model may wrap its answer in.
const MARKUP = /[*_#>~]/g;
const LEADING_BULLET = /^(?:[-•·]+|\d+[.)])\s+/;
const PREFIX = /^(?:label|title|topic|summary)\s*[:\-–—]\s*/i;
const TRAILING = /[\s.,;:!?…\-–—/\\|()[\]{}]+$/;
const LEADING = /^[\s.,;:!?…\-–—/\\|()[\]{}]+/;

function trimEdges(text: string): string {
  return text.replace(TRAILING, "").replace(LEADING, "");
}

/**
 * A model's answer as a pill label, or null when nothing usable is left.
 * Longer answers keep their first {@link LABEL_MAX_WORDS} words and are then
 * cut on a word boundary to fit {@link LABEL_MAX_CHARS}; a single word longer
 * than that is cut at the limit.
 */
export function normaliseLabel(raw: string): string | null {
  // The first line that still says something once cleaned: a model may put
  // a bare "Label:" or an empty quote ahead of its answer.
  for (const line of raw.split(/[\r\n\u2028\u2029]+/)) {
    const label = cleanLine(line);
    if (label) return label;
  }
  return null;
}

function cleanLine(line: string): string | null {
  const text = trimEdges(
    line
      .replace(INVISIBLE, " ")
      .replace(QUOTES, "")
      .replace(MARKUP, "")
      .trim()
      .replace(LEADING_BULLET, "")
      .replace(PREFIX, "")
      .replace(/\s+/g, " ")
  );
  const words = text.split(" ").filter(Boolean).slice(0, LABEL_MAX_WORDS);
  let label = "";
  for (const word of words) {
    const next = label ? `${label} ${word}` : word;
    if (next.length > LABEL_MAX_CHARS) break;
    label = next;
  }
  // One word longer than a pill: cut it rather than print nothing.
  if (!label && words[0]) {
    for (const char of words[0]) {
      if (label.length + char.length > LABEL_MAX_CHARS) break;
      label += char;
    }
  }
  label = trimEdges(label);
  return label ? label : null;
}
