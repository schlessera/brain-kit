/**
 * The Apify canonicaliser's rule (#4772). Apify digests and approval keys hash
 * its output and are stored, so these literals must never change; the inputs
 * are the ones on which the repository's three `canonicalJson` functions differ.
 */
import { expect, test } from "bun:test";

import { canonicalJson, sha256 } from "../src/apify/canonical";

test("pins the output on the inputs where the three canonicalisers differ", () => {
  expect(canonicalJson({ b: 1, a: undefined })).toBe(`{"a":null,"b":1}`);
  expect(canonicalJson([1, undefined, 2])).toBe(`[1,null,2]`);
  expect(canonicalJson(Number.NaN)).toBe(`null`);
  expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe(`null`);
  expect(canonicalJson(-0)).toBe(`0`);
  expect(canonicalJson(new Date(0))).toBe(`{}`);
  expect(canonicalJson({ z: { y: 1, x: [{ b: 2, a: 1 }] }, a: "s" })).toBe(`{"a":"s","z":{"x":[{"a":1,"b":2}],"y":1}}`);
});

test("pins the digest of one input that carries every difference", () => {
  const value = { member: { b: 1, a: undefined }, array: [1, undefined, 2], nan: Number.NaN, inf: Number.POSITIVE_INFINITY, negZero: -0, date: new Date(0) };
  expect(canonicalJson(value)).toBe(`{"array":[1,null,2],"date":{},"inf":null,"member":{"a":null,"b":1},"nan":null,"negZero":0}`);
  expect(sha256(canonicalJson(value))).toBe("f29a89355ad458ea7876fc58990490730c4ef003793a0135fe6b5a717133dd34");
});
