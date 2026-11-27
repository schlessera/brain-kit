import { describe, expect, test } from "bun:test";
import { clipUtf8 } from "../src/clip-utf8.js";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("clipUtf8 (#4773)", () => {
  test("text under the limit is unchanged", () => {
    expect(clipUtf8("Ithaca", 6)).toBe("Ithaca");
    expect(clipUtf8("Ithaca", 100)).toBe("Ithaca");
  });

  // "Ἰθάκη" opens with a three-byte letter; "é" is two bytes; "🌊" is four.
  for (const [label, text, limit, expected] of [
    ["inside a two-byte sequence", "café", 4, "caf"],
    ["inside a three-byte sequence", "Ἰθάκη", 2, ""],
    ["inside a two-byte sequence after a three-byte one", "Ἰθάκη", 4, "Ἰ"],
    ["inside a four-byte sequence", "sea 🌊 wine", 6, "sea "],
    ["three bytes into a four-byte sequence", "sea 🌊 wine", 7, "sea "],
  ] as const) test(`a limit ${label} cuts before it`, () => {
    const clipped = clipUtf8(text, limit);
    expect(clipped).toBe(expected);
    expect(bytes(clipped)).toBeLessThanOrEqual(limit);
  });

  test("a limit of zero is empty", () => {
    expect(clipUtf8("Odysseus", 0)).toBe("");
  });
});
