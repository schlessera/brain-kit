import { describe, expect, test } from "bun:test";
import { base64DecodedLength, base64ToBytes, bytesToBase64 } from "../src/lib/base64.js";

/** `length` bytes cycling through every byte value. */
const cycle = (length: number) => Uint8Array.from({ length }, (_, i) => i % 256);

describe("base64 helpers (#4726)", () => {
  test("pins a known encoding", () => {
    expect(bytesToBase64(new Uint8Array([0, 255, 16]))).toBe("AP8Q");
    expect(base64ToBytes("AP8Q")).toEqual(new Uint8Array([0, 255, 16]));
  });

  for (const length of [0, 1, 2, 3, 4, 4097]) test(`round-trips ${length} bytes and counts them from the text`, () => {
    const bytes = cycle(length);
    const text = bytesToBase64(bytes);
    // The platform's own encoder is the reference for the text.
    expect(text).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64ToBytes(text)).toEqual(bytes);
    expect(base64DecodedLength(text)).toBe(length);
  });

  test("the round-trip set contains every byte value", () => {
    expect(new Set(cycle(4097)).size).toBe(256);
  });

  test("text that is not base64 throws as atob does", () => {
    expect(() => base64ToBytes("not base64!")).toThrow();
  });
});
