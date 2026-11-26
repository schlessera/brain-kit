/**
 * `revealInvisibles` (#4209, ruling G4): what the owner cannot see becomes a
 * `‹U+XXXX›` marker; ordinary spelling that merely uses such a character
 * stays as written.
 */
import { describe, expect, test } from "bun:test";

import { codeLabel, hasInvisibles, invisibleName, invisibleSegments, revealInvisibles, scanInvisibles, type ScanMeter } from "../src/google/reveal-invisibles.js";

describe("revealInvisibles: hidden characters become markers", () => {
  test.each([
    ["a right-to-left override", "invoice-\u{202E}fdp.exe", "invoice-‹U+202E›fdp.exe"],
    ["every bidi control", "\u{202A}\u{202B}\u{202C}\u{202D}\u{2066}\u{2067}\u{2068}\u{2069}\u{200E}\u{200F}\u{061C}", "‹U+202A›‹U+202B›‹U+202C›‹U+202D›‹U+2066›‹U+2067›‹U+2068›‹U+2069›‹U+200E›‹U+200F›‹U+061C›"],
    ["a zero-width space inside a word", "Ithaca\u{200B}Steward", "Ithaca‹U+200B›Steward"],
    ["a joiner between Latin letters", "pay\u{200D}pal and pay\u{200C}pal", "pay‹U+200D›pal and pay‹U+200C›pal"],
    ["a word joiner and a byte-order mark", "a\u{2060}b\u{FEFF}c", "a‹U+2060›b‹U+FEFF›c"],
    ["a soft hyphen and a grapheme joiner", "shr\u{00AD}oud\u{034F}", "shr‹U+00AD›oud‹U+034F›"],
    ["a C0 and a C1 control", "a\u{0007}b\u{0085}c", "a‹U+0007›b‹U+0085›c"],
    ["line and paragraph separators", "a\u{2028}b\u{2029}c", "a‹U+2028›b‹U+2029›c"],
    ["tag characters spelling a hidden word", "ok\u{E0049}\u{E0047}\u{E004E}", "ok‹U+E0049›‹U+E0047›‹U+E004E›"],
    ["a variation selector with nothing to select", "\u{FE0F}start", "‹U+FE0F›start"],
    ["a second variation selector after the first", "\u{2764}\u{FE0F}\u{FE0F}", "\u{2764}\u{FE0F}‹U+FE0F›"],
    ["a supplementary variation selector run smuggled behind a letter", "a\u{E0100}\u{E0101}", "a‹U+E0100›‹U+E0101›"],
    ["a Hangul filler", "x\u{3164}y", "x‹U+3164›y"],
    ["a lone surrogate", "a\u{D800}b", "a‹U+D800›b"],
  ])("%s", (_name, input, expected) => {
    expect(revealInvisibles(input)).toBe(expected);
    expect(hasInvisibles(input)).toBe(true);
  });

  test("three or more of one character read as one counted run", () => {
    expect(revealInvisibles("Settle today\u{200B}\u{200B}\u{200B}\u{200B} or")).toBe("Settle today‹U+200B ×4› or");
    expect(revealInvisibles("a\u{200B}\u{200B}b")).toBe("a‹U+200B›‹U+200B›b");
    expect(revealInvisibles("a\u{200B}\u{200C}\u{200B}b")).toBe("a‹U+200B›‹U+200C›‹U+200B›b");
  });

  test("a marker says what it is, for a screen reader", () => {
    const segments = invisibleSegments("x\u{202E}y\u{200B}\u{200B}\u{200B}");
    expect(segments).toEqual([
      { kind: "text", text: "x" },
      { kind: "hidden", code: 0x202e, count: 1, marker: "‹U+202E›", spoken: "hidden character: right-to-left override" },
      { kind: "text", text: "y" },
      { kind: "hidden", code: 0x200b, count: 3, marker: "‹U+200B ×3›", spoken: "3 hidden characters: zero-width space" },
    ]);
    expect(invisibleName(0x0001)).toBe("control character");
    expect(invisibleName(0xe0041)).toBe("tag character");
    expect(invisibleName(0xfe0e)).toBe("variation selector");
    expect(codeLabel(0x200b)).toBe("U+200B");
    expect(codeLabel(0xad)).toBe("U+00AD");
    expect(codeLabel(0xe0049)).toBe("U+E0049");
  });
});

describe("revealInvisibles: ordinary spelling stays as written", () => {
  test.each([
    ["plain text with tab and newlines", "Tell them\tit's for Laertes.\r\nIt is, after all.\n"],
    ["an emoji with its presentation selector", "\u{2764}\u{FE0F} from Ithaca"],
    ["a keycap", "1\u{FE0F}\u{20E3}"],
    ["an emoji joined into one picture", "\u{1F469}\u{200D}\u{1F4BB} and \u{1F468}\u{1F3FD}\u{200D}\u{1F33E}"],
    ["a family joined three times", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"],
    ["a Persian word spelled with a non-joiner", "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}"],
    ["a Devanagari conjunct with a joiner", "\u{0915}\u{094D}\u{200D}\u{0937}"],
    ["a flag spelled with tag characters", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"],
    ["Arabic number signs, which draw a sign", "\u{0600}\u{0661}\u{0662}"],
    ["right-to-left text with no control", "\u{05E9}\u{05DC}\u{05D5}\u{05DD} Ithaca"],
    ["an ideographic variation selector after its ideograph", "\u{845B}\u{E0100}"],
  ])("%s", (_name, input) => {
    expect(revealInvisibles(input)).toBe(input);
    expect(hasInvisibles(input)).toBe(false);
  });

  test("a joiner between a pictograph and a letter is not spelling", () => {
    expect(revealInvisibles("\u{1F469}\u{200D}a")).toBe("\u{1F469}‹U+200D›a");
  });

  test("a non-joiner between scripts is not spelling", () => {
    expect(revealInvisibles("\u{0645}\u{200C}a")).toBe("\u{0645}‹U+200C›a");
  });

  test("tag characters after anything but the black flag are revealed", () => {
    expect(revealInvisibles("\u{1F3F3}\u{E0067}\u{E007F}")).toBe("\u{1F3F3}‹U+E0067›‹U+E007F›");
    expect(revealInvisibles("\u{1F3F4}\u{E0067}\u{E0062}")).toBe("\u{1F3F4}‹U+E0067›‹U+E0062›");
  });

  test.each([
    ["England", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["Scotland", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"],
    ["Wales", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}"],
    ["a rainbow flag: a selector, then a joiner between pictographs", "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}"],
    ["a keycap hash", "#\u{FE0F}\u{20E3}"],
    ["a text-presentation selector after an emoji-capable character", "\u{00A9}\u{FE0E} Ithaca"],
    ["Persian with a vowel mark before its non-joiner", "\u{0645}\u{064E}\u{200C}\u{062E}"],
    ["a Mongolian letter with its free variation selector", "\u{1820}\u{180B}"],
  ])("the recognised spelling stays: %s", (_name, input) => {
    expect(revealInvisibles(input)).toBe(input);
  });
});

// Every exemption recognises a spelling, never a shape (#4209 review, F1):
// each case is the shape of an exemption carrying something else.
describe("revealInvisibles: a shape that only looks like spelling is revealed", () => {
  const tag = (text: string) => Array.from(text, (ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0)!)).join("");
  const markers = (text: string) => Array.from(text, (ch) => `‹U+${(0xe0000 + ch.codePointAt(0)!).toString(16).toUpperCase()}›`).join("");

  test.each([
    ["an arbitrary tag sentence wrapped in a black flag", `\u{1F3F4}${tag("IGNORE")}\u{E007F}`, `\u{1F3F4}${markers("IGNORE")}‹U+E007F›`],
    ["a lowercase tag sentence wrapped in a black flag", `\u{1F3F4}${tag("ignore the owner")}\u{E007F}`, `\u{1F3F4}${markers("ignore the owner")}‹U+E007F›`],
    ["a subdivision flag that is not recommended (Northern Ireland)", `\u{1F3F4}${tag("gbnir")}\u{E007F}`, `\u{1F3F4}${markers("gbnir")}‹U+E007F›`],
    ["a region-shaped subdivision (California)", `\u{1F3F4}${tag("usca")}\u{E007F}`, `\u{1F3F4}${markers("usca")}‹U+E007F›`],
    ["a recommended flag spelled in upper-case tag letters", `\u{1F3F4}${tag("GBSCT")}\u{E007F}`, `\u{1F3F4}${markers("GBSCT")}‹U+E007F›`],
    ["a recommended flag with more tags before its cancel tag", `\u{1F3F4}${tag("gbsctx")}\u{E007F}`, `\u{1F3F4}${markers("gbsctx")}‹U+E007F›`],
    ["one ideographic selector per Latin letter", "a\u{E0100}b\u{E0101}c\u{E0102}", "a‹U+E0100›b‹U+E0101›c‹U+E0102›"],
    ["an emoji presentation selector on a Latin letter", "a\u{FE0F}b", "a‹U+FE0F›b"],
    ["a selector after a digit with no keycap", "1\u{FE0F} and 2\u{FE0E}", "1‹U+FE0F› and 2‹U+FE0E›"],
    ["a standardized-variant selector (U+FE00–U+FE0D), even after an emoji", "\u{2764}\u{FE00} x\u{FE0D}", "\u{2764}‹U+FE00› x‹U+FE0D›"],
    ["an ideographic selector after an emoji", "\u{2764}\u{E0100}", "\u{2764}‹U+E0100›"],
    ["a Mongolian selector after a Latin letter", "a\u{180B}", "a‹U+180B›"],
    ["a joiner between Arabic digits", "\u{0661}\u{200D}\u{0662}", "\u{0661}‹U+200D›\u{0662}"],
    ["a non-joiner between Arabic punctuation and a letter", "\u{060C}\u{200C}\u{0645}", "\u{060C}‹U+200C›\u{0645}"],
    ["a non-joiner between letters of two joining scripts", "\u{0645}\u{200C}\u{0915}", "\u{0645}‹U+200C›\u{0915}"],
    ["a joiner between Devanagari digits", "\u{0967}\u{200D}\u{0968}", "\u{0967}‹U+200D›\u{0968}"],
    ["two joiners between pictographs", "\u{1F469}\u{200D}\u{200D}\u{1F4BB}", "\u{1F469}‹U+200D›‹U+200D›\u{1F4BB}"],
  ])("%s", (_name, input, expected) => {
    expect(revealInvisibles(input)).toBe(expected);
    expect(hasInvisibles(input)).toBe(true);
  });
});

// The scanner's work is linear in the input (#4209 review, F2), proved by
// counting its reads, not by timing it. Each code point is read for itself
// and by its two neighbours in the first pass, once in the second, and a
// black flag reads the six code points a subdivision flag spells: at most
// 10 reads per code point.
describe("revealInvisibles: work proportional to the input", () => {
  const PER_CODE_POINT = 10;
  const tags = (n: number) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0xe0061 + (i % 26))).join("");

  test.each([
    ["16,000 tag letters wrapped in a black flag and a cancel tag", `\u{1F3F4}${tags(16_000)}\u{E007F}`],
    ["16,000 bare tag letters", tags(16_000)],
    ["16,000 of one tag character", "\u{E0067}".repeat(16_000)],
    ["3,200 black flags, each before four tag letters", `\u{1F3F4}${tags(4)}`.repeat(3_200)],
    ["2,300 black flags, each before five tag letters and a cancel tag", `\u{1F3F4}${tags(5)}\u{E007F}`.repeat(2_300)],
    ["16,000 zero-width spaces", "\u{200B}".repeat(16_000)],
    ["8,000 Latin letters, each with a selector", "a\u{E0100}".repeat(8_000)],
    ["skin tones between pictographs and joiners", "\u{1F469}\u{1F3FD}\u{FE0F}\u{200D}".repeat(4_000)],
  ])("%s: at most a constant number of reads per code point", (_name, input) => {
    const meter: ScanMeter = { reads: 0 };
    const segments = scanInvisibles(input, meter);
    expect(segments, "the metered scan is the one invisibleSegments runs").toEqual(invisibleSegments(input));
    const length = Array.from(input).length;
    expect(length).toBeGreaterThan(15_000);
    expect(meter.reads, "the meter counts every code point").toBeGreaterThanOrEqual(length);
    expect(meter.reads).toBeLessThanOrEqual(PER_CODE_POINT * length);
    expect(segments.some((segment) => segment.kind === "hidden")).toBe(true);
  });
});
