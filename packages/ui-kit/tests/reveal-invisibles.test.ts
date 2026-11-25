/**
 * `revealInvisibles` (#4209, ruling G4): what the owner cannot see becomes a
 * `‹U+XXXX›` marker; ordinary spelling that merely uses such a character
 * stays as written.
 */
import { describe, expect, test } from "bun:test";

import { codeLabel, hasInvisibles, invisibleName, invisibleSegments, revealInvisibles } from "../src/google/reveal-invisibles.js";

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
    ["a supplementary variation selector run smuggled behind a letter", "a\u{E0100}\u{E0101}", "a\u{E0100}‹U+E0101›"],
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
});
