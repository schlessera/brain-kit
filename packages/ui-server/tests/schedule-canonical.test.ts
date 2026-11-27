/**
 * The schedule canonicaliser's rule (#4772). Every approved schedule stores
 * the fingerprint its output hashes, so these literals must never change; the
 * inputs are the ones on which the repository's three `canonicalJson`
 * functions differ. This one refuses what it cannot represent exactly.
 */
import { expect, test } from "bun:test";

import { canonicalJson, scheduleFingerprint } from "../src/schedules/canonical";

test("pins the output on the inputs where the three canonicalisers differ", () => {
  expect(() => canonicalJson({ b: 1, a: undefined })).toThrow(new TypeError("Unsupported undefined in canonical JSON"));
  expect(() => canonicalJson([1, undefined, 2])).toThrow(new TypeError("Unsupported undefined in canonical JSON"));
  expect(() => canonicalJson(Number.NaN)).toThrow(new TypeError("Non-finite number in canonical JSON"));
  expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(new TypeError("Non-finite number in canonical JSON"));
  expect(canonicalJson(-0)).toBe(`0`);
  expect(() => canonicalJson(new Date(0))).toThrow(new TypeError("Non-plain object in canonical JSON"));
  expect(canonicalJson({ z: { y: 1, x: [{ b: 2, a: 1 }] }, a: "s" })).toBe(`{"a":"s","z":{"x":[{"a":1,"b":2}],"y":1}}`);
});

test("pins the fingerprint of a subject the rule can represent", () => {
  const subject = { definition: { prompt: "Mend the sail", negZero: -0, z: [true, null] }, rootIdentity: "ithaca", creatorPrincipalId: "penelope", executionPolicy: { b: 1, a: "x" } };
  expect(canonicalJson(subject)).toBe(`{"creatorPrincipalId":"penelope","definition":{"negZero":0,"prompt":"Mend the sail","z":[true,null]},"executionPolicy":{"a":"x","b":1},"rootIdentity":"ithaca"}`);
  expect(scheduleFingerprint(subject)).toBe("78ff1baeda6ad0ea8851d3d7568aace759536a507f4b317482d4bb25dd5e3032");
});
