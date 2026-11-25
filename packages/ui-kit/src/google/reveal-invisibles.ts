/**
 * `revealInvisibles` — characters that draw nothing or reorder their
 * neighbours, made visible as `‹U+XXXX›` before the text reaches the screen
 * (#4209, maintainer ruling G4). Shared by every Google component (#4209,
 * #4215, #4224, #4228); `UntrustedText` itself is unchanged.
 *
 * Mail is written by strangers. A right-to-left override (U+202E) can make
 * a file named `invoice`, RLO, `fdp.exe` read as `invoiceexe.pdf`, a zero-width space can split a
 * word so a search misses it, and tag characters can carry a whole hidden
 * sentence. Isolating bidi (`<bdi>`, `UntrustedText`) stops the text
 * reordering the chrome around it; it does not tell the owner the text holds
 * something they cannot see. This does: each such character becomes a marker
 * naming its code point, so the owner reads exactly what is there.
 *
 * Revealed: C0 and C1 controls other than tab, line feed and carriage
 * return; every format character (`Cf`), which covers the bidi controls,
 * zero-width spaces and joiners and the tag characters; every default
 * ignorable code point (soft hyphen, Hangul fillers, variation selectors…);
 * the line and paragraph separators; and lone surrogates.
 *
 * Kept, because each is how ordinary writing is spelled and reveals nothing
 * hidden:
 * - the prepended concatenation marks (Arabic number signs and the like),
 *   format characters that draw a visible sign;
 * - one variation selector directly after the character it selects for (the
 *   red heart emoji is U+2764 U+FE0F). A second selector in a row selects nothing
 *   and is revealed: that is how text is smuggled behind an emoji;
 * - a zero-width joiner inside an emoji sequence (woman, U+200D, laptop);
 * - a zero-width joiner or non-joiner between two letters of a script that
 *   uses them to choose letter forms (Persian, the Indic scripts);
 * - the tag characters of a flag sequence (U+1F3F4, tag letters, cancel tag).
 *
 * Three or more of the same character in a row become one counted marker,
 * `‹U+200B ×12›`, so a run of padding reads as one fact, not a wall.
 *
 * Pure: no DOM, no React, linear in the input.
 */

/** One piece of revealed text: text as written, or a run of one hidden character. */
export type InvisibleSegment =
  | { kind: "text"; text: string }
  | {
      kind: "hidden";
      /** The code point. */
      code: number;
      /** How many times it occurs in a row. */
      count: number;
      /** What the owner sees: `‹U+202E›`, or `‹U+200B ×12›` for a run. */
      marker: string;
      /** What a screen reader says: "hidden character: right-to-left override". */
      spoken: string;
    };

const HIDDEN = /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\p{Cs}]$/u;
const SHOWN_CONTROLS = new Set([0x09, 0x0a, 0x0d]);
/** Format characters that draw a visible sign (Unicode's Prepended_Concatenation_Mark). */
const PREPENDED_MARK = /^[\u{600}-\u{605}\u{6DD}\u{70F}\u{890}\u{891}\u{8E2}\u{110BD}\u{110CD}]$/u;
const VARIATION_SELECTOR = /^\p{Variation_Selector}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const EMOJI_COMPONENT = /^[\p{Emoji_Modifier}\u{FE0F}]$/u;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
/** Scripts whose letters a joiner or non-joiner joins or parts as a matter of spelling. */
const JOINING_SCRIPTS = [
  "Arabic", "Syriac", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala",
].map((script) => new RegExp(`^[\\p{Script=${script}}]$`, "u"));

const NAMES: Record<number, string> = {
  0x00ad: "soft hyphen",
  0x034f: "combining grapheme joiner",
  0x061c: "Arabic letter mark",
  0x115f: "Hangul filler",
  0x1160: "Hangul filler",
  0x17b4: "Khmer inherent vowel",
  0x17b5: "Khmer inherent vowel",
  0x180e: "Mongolian vowel separator",
  0x200b: "zero-width space",
  0x200c: "zero-width non-joiner",
  0x200d: "zero-width joiner",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x2028: "line separator",
  0x2029: "paragraph separator",
  0x202a: "left-to-right embedding",
  0x202b: "right-to-left embedding",
  0x202c: "pop directional formatting",
  0x202d: "left-to-right override",
  0x202e: "right-to-left override",
  0x2060: "word joiner",
  0x2061: "function application",
  0x2062: "invisible times",
  0x2063: "invisible separator",
  0x2064: "invisible plus",
  0x2066: "left-to-right isolate",
  0x2067: "right-to-left isolate",
  0x2068: "first strong isolate",
  0x2069: "pop directional isolate",
  0x3164: "Hangul filler",
  0xfeff: "zero-width no-break space",
  0xffa0: "Hangul filler",
};

/** What a hidden code point is called, for a screen reader. */
export function invisibleName(code: number): string {
  const named = NAMES[code];
  if (named) return named;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return "control character";
  if ((code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef) || (code >= 0x180b && code <= 0x180f)) return "variation selector";
  if (code >= 0xe0000 && code <= 0xe007f) return "tag character";
  if (code >= 0xd800 && code <= 0xdfff) return "broken character";
  if (code >= 0xfff9 && code <= 0xfffb) return "interlinear annotation mark";
  return "invisible character";
}

/** `U+202E`: four hex digits at least, upper case. */
export function codeLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

const isHidden = (code: number, ch: string) => !SHOWN_CONTROLS.has(code) && HIDDEN.test(ch) && !PREPENDED_MARK.test(ch);

/** Whether the hidden character at `i` is one ordinary spelling needs (see the module comment). */
function spelled(chars: string[], codes: number[], i: number): boolean {
  const code = codes[i]!;
  const ch = chars[i]!;
  const prev = chars[i - 1];
  const next = chars[i + 1];
  if (VARIATION_SELECTOR.test(ch)) {
    return prev !== undefined && !isHidden(codes[i - 1]!, prev);
  }
  if (code === ZWJ && prev !== undefined && next !== undefined && PICTOGRAPH.test(next)) {
    // Back over a skin tone or an emoji presentation selector to the pictograph.
    let j = i - 1;
    while (j > 0 && EMOJI_COMPONENT.test(chars[j]!)) j--;
    if (PICTOGRAPH.test(chars[j]!)) return true;
  }
  if ((code === ZWJ || code === ZWNJ) && prev !== undefined && next !== undefined) {
    if (JOINING_SCRIPTS.some((script) => script.test(prev) && script.test(next))) return true;
  }
  if (code >= 0xe0020 && code <= CANCEL_TAG) {
    // A flag: the black flag, a run of tag letters, the cancel tag.
    let start = i;
    while (start > 0 && codes[start - 1]! >= 0xe0020 && codes[start - 1]! < CANCEL_TAG) start--;
    let end = i;
    while (end < codes.length && codes[end]! >= 0xe0020 && codes[end]! < CANCEL_TAG) end++;
    return codes[start - 1] === BLACK_FLAG && codes[end] === CANCEL_TAG && end > start;
  }
  return false;
}

/** The text as segments: what is written, and each run of a hidden character. */
export function invisibleSegments(text: string): InvisibleSegment[] {
  const chars = Array.from(text);
  const codes = chars.map((ch) => ch.codePointAt(0)!);
  const out: InvisibleSegment[] = [];
  let run = "";
  for (let i = 0; i < chars.length; i++) {
    const code = codes[i]!;
    if (!isHidden(code, chars[i]!) || spelled(chars, codes, i)) {
      run += chars[i];
      continue;
    }
    let count = 1;
    while (codes[i + count] === code && !spelled(chars, codes, i + count)) count++;
    if (run) out.push({ kind: "text", text: run });
    run = "";
    const name = invisibleName(code);
    // Three or more in a row read as one counted run; one or two stay single markers.
    if (count >= 3) {
      out.push({ kind: "hidden", code, count, marker: `‹${codeLabel(code)} ×${count}›`, spoken: `${count} hidden characters: ${name}` });
      i += count - 1;
    } else {
      out.push({ kind: "hidden", code, count: 1, marker: `‹${codeLabel(code)}›`, spoken: `hidden character: ${name}` });
    }
  }
  if (run) out.push({ kind: "text", text: run });
  return out;
}

/** The text with every hidden character replaced by its marker, `‹U+XXXX›`. */
export function revealInvisibles(text: string): string {
  let out = "";
  for (const segment of invisibleSegments(text)) out += segment.kind === "text" ? segment.text : segment.marker;
  return out;
}

/** Whether the text holds anything `revealInvisibles` would reveal. */
export function hasInvisibles(text: string): boolean {
  return invisibleSegments(text).some((segment) => segment.kind === "hidden");
}
