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
 * hidden. Each exemption recognises a spelling, not a shape; everything else
 * is revealed:
 * - the prepended concatenation marks (Arabic number signs and the like),
 *   format characters that draw a visible sign;
 * - one variation selector directly after a base it can select for, and
 *   only that pairing: U+FE0E or U+FE0F after an emoji-capable character
 *   (`Extended_Pictographic`, `Emoji_Presentation`), or after a keycap base
 *   (`0`–`9`, `#`, `*`) when U+20E3 follows (the red heart emoji is U+2764
 *   U+FE0F; keycap one is `1` U+FE0F U+20E3); an ideographic variation
 *   selector (U+E0100–U+E01EF) after a Han ideograph; a Mongolian selector
 *   (U+180B–U+180F) after a Mongolian letter. U+FE00–U+FE0D, a selector
 *   after any other base (a Latin letter, a digit with no keycap), and a
 *   second selector in a row are revealed: that is how text is smuggled one
 *   selector per letter, or behind an emoji;
 * - a zero-width joiner between two pictographs (woman, U+200D, laptop),
 *   skipping back over the skin tones and U+FE0F of the first;
 * - a zero-width joiner or non-joiner between two letters or marks of one
 *   script that uses them to choose letter forms (Persian, the Indic
 *   scripts). A digit or punctuation beside it, or two different scripts,
 *   is not spelling;
 * - the tag characters of the three recommended subdivision flags, and only
 *   those: U+1F3F4, the lowercase tag letters of `gbeng`, `gbsct` or
 *   `gbwls`, U+E007F. Any other tag run, after a black flag or not, is
 *   revealed.
 *
 * What the exemptions still let through, by design. They admit ordinary
 * spelling, so a sender can still choose among spellings the owner cannot
 * tell apart: whether two adjacent pictographs carry a joiner (one per
 * pair, whether or not the pair is a recommended emoji sequence), which of
 * the 240 ideographic variation selectors follows each Han ideograph,
 * whether an emoji-capable character carries U+FE0E or U+FE0F, which
 * Mongolian selector follows each Mongolian letter, and whether a joiner
 * or non-joiner sits between two letters of a joining script. Each is a
 * covert channel of a few bits per visible character, never a hidden run:
 * a run of any of them, or one in any other place, is revealed.
 *
 * Three or more of the same character in a row become one counted marker,
 * `‹U+200B ×12›`, so a run of padding reads as one fact, not a wall.
 *
 * Pure: no DOM, no React. Linear in the input: one forward pass classifies
 * every code point from itself, its two neighbours and, after a black
 * flag, the six code points a subdivision flag spells, and a second pass
 * groups the runs, visiting each code point once. Every read a decision
 * rests on goes through one accessor, so a `ScanMeter` handed to
 * `scanInvisibles` counts all of the scanning (`tests/reveal-invisibles.test.ts`
 * bounds it per code point).
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
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
/** A base U+FE0E or U+FE0F selects a presentation for. */
const EMOJI_BASE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u;
/** What a skin tone or presentation selector sits between a pictograph and its joiner. */
const EMOJI_COMPONENT = /^[\p{Emoji_Modifier}\u{FE0F}]$/u;
const HAN = /^\p{Script=Han}$/u;
const MONGOLIAN_LETTER = /^(?=\p{L})\p{Script=Mongolian}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
/** `0`–`9`, `#` and `*`: a keycap's base, before U+FE0F U+20E3. */
const KEYCAP_BASES = new Set([0x23, 0x2a, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
const KEYCAP = 0x20e3;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
/** The lowercase tag letters a subdivision flag is spelled with, U+E0061–U+E007A. */
const TAG_A = 0xe0061;
const TAG_Z = 0xe007a;
/** The recommended-for-general-interchange subdivision flags: England, Scotland, Wales. */
const RGI_SUBDIVISIONS = new Set(["gbeng", "gbsct", "gbwls"]);
/**
 * Scripts whose letters a joiner or non-joiner joins or parts as a matter of
 * spelling. Script_Extensions, so the Arabic vowel marks, whose Script is
 * Inherited, count as Arabic.
 */
const JOINING_SCRIPTS = [
  "Arabic", "Syriac", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala",
].map((script) => new RegExp(`^\\p{Script_Extensions=${script}}$`, "u"));

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

const char = (code: number) => String.fromCodePoint(code);

const isHidden = (code: number) => !SHOWN_CONTROLS.has(code) && HIDDEN.test(char(code)) && !PREPENDED_MARK.test(char(code));

const isSelector = (code: number) => (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef) || (code >= 0x180b && code <= 0x180f);

/** Whether the variation selector `code` selects for `prev`, the code point before it (see the module comment). */
function selects(prev: number | undefined, code: number, next: number | undefined): boolean {
  if (prev === undefined) return false;
  if (code === 0xfe0e || code === 0xfe0f) return EMOJI_BASE.test(char(prev)) || (KEYCAP_BASES.has(prev) && next === KEYCAP);
  if (code >= 0xe0100) return HAN.test(char(prev));
  if (code >= 0x180b && code <= 0x180f) return MONGOLIAN_LETTER.test(char(prev));
  return false;
}

/** Whether a joiner or non-joiner between `prev` and `next` is spelling: two letters or marks of one joining script. */
function joins(prev: number | undefined, next: number | undefined): boolean {
  if (prev === undefined || next === undefined) return false;
  const a = char(prev);
  const b = char(next);
  return LETTER_OR_MARK.test(a) && LETTER_OR_MARK.test(b) && JOINING_SCRIPTS.some((script) => script.test(a) && script.test(b));
}

/** Counts the scanner's reads of the input, for the proof that its work is linear (#4209 review, F2). */
export interface ScanMeter {
  reads: number;
}

/** The text as segments: what is written, and each run of a hidden character. */
export function invisibleSegments(text: string): InvisibleSegment[] {
  return scanInvisibles(text);
}

/** `invisibleSegments`, counting its reads of the input in `meter` (module-level: the linear-work proof's entry). */
export function scanInvisibles(text: string, meter?: ScanMeter): InvisibleSegment[] {
  const chars = Array.from(text);
  const n = chars.length;
  const codes = chars.map((ch) => ch.codePointAt(0)!);
  // The one way the scanner reads a code point to decide anything, so `meter` sees all of its scanning.
  const at = (i: number): number | undefined => {
    if (meter) meter.reads++;
    return i >= 0 && i < n ? codes[i] : undefined;
  };

  /** The index of the cancel tag closing a recommended subdivision flag whose black flag is at `i`, else -1. */
  const flagEnd = (i: number): number => {
    let spelled = "";
    for (let k = 1; k <= 5; k++) {
      const code = at(i + k);
      if (code === undefined || code < TAG_A || code > TAG_Z) return -1;
      spelled += String.fromCharCode(code - 0xe0000);
    }
    return at(i + 6) === CANCEL_TAG && RGI_SUBDIVISIONS.has(spelled) ? i + 6 : -1;
  };

  // Pass 1: classify every code point once, from itself and its neighbours.
  const reveal = new Uint8Array(n);
  let flagUntil = -1;
  // Whether the last code point that is not a skin tone or U+FE0F was a pictograph: an emoji joiner's left side.
  let afterPictograph = false;
  for (let i = 0; i < n; i++) {
    const code = at(i)!;
    if (code === BLACK_FLAG && i > flagUntil) flagUntil = flagEnd(i);
    if (i > flagUntil || code === BLACK_FLAG) {
      if (isHidden(code)) {
        let spelling = false;
        if (isSelector(code)) spelling = selects(at(i - 1), code, at(i + 1));
        else if (code === ZWJ || code === ZWNJ) {
          const next = at(i + 1);
          spelling = (code === ZWJ && afterPictograph && next !== undefined && PICTOGRAPH.test(char(next))) || joins(at(i - 1), next);
        }
        if (!spelling) reveal[i] = 1;
      }
    }
    if (!EMOJI_COMPONENT.test(char(code))) afterPictograph = PICTOGRAPH.test(char(code));
  }

  // Pass 2: text as written, and each run of one revealed character, visiting each code point once.
  const out: InvisibleSegment[] = [];
  let run = "";
  for (let i = 0; i < n; ) {
    const code = at(i)!;
    if (!reveal[i]) {
      run += chars[i];
      i++;
      continue;
    }
    let count = 1;
    while (i + count < n && reveal[i + count] && at(i + count) === code) count++;
    if (run) out.push({ kind: "text", text: run });
    run = "";
    const name = invisibleName(code);
    // Three or more in a row read as one counted run; one or two stay single markers.
    if (count >= 3) {
      out.push({ kind: "hidden", code, count, marker: `‹${codeLabel(code)} ×${count}›`, spoken: `${count} hidden characters: ${name}` });
      i += count;
    } else {
      out.push({ kind: "hidden", code, count: 1, marker: `‹${codeLabel(code)}›`, spoken: `hidden character: ${name}` });
      i++;
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
