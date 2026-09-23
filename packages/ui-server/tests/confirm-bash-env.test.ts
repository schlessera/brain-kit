/**
 * BRAIN_UI_CONFIRM_BASH carries the same two shapes the backends accept
 * (#112): bare regex sources, and `{ pattern, effect }` objects whose effect
 * the approval card shows. An entry the parser cannot use must never turn the
 * confirmation off by accident — the safe direction is the shipped defaults.
 */
import { describe, expect, test } from "bun:test";

import { resolveServerConfig } from "../src/config/env";

const patternsFrom = (value: string) =>
  resolveServerConfig({ BRAIN_UI_CONFIRM_BASH: value }).agent.confirmBashPatterns;

describe("BRAIN_UI_CONFIRM_BASH", () => {
  test("bare sources pass through as before", () => {
    expect(patternsFrom(String.raw`["\\bdeploy\\b"]`)).toEqual([String.raw`\bdeploy\b`]);
  });

  test("the object form keeps its effect", () => {
    expect(
      patternsFrom(JSON.stringify([{ pattern: String.raw`\bdeploy\b`, effect: "ship to production" }]))
    ).toEqual([{ pattern: String.raw`\bdeploy\b`, effect: "ship to production" }]);
  });

  test("the two forms mix", () => {
    expect(
      patternsFrom(JSON.stringify([String.raw`\bfoo\b`, { pattern: String.raw`\bbar\b`, effect: "bar it" }]))
    ).toEqual([String.raw`\bfoo\b`, { pattern: String.raw`\bbar\b`, effect: "bar it" }]);
  });

  test("an explicit empty array still disables the confirmation", () => {
    expect(patternsFrom("[]")).toEqual([]);
  });

  test("entries it cannot use are dropped, and all-unusable means the defaults, not none", () => {
    expect(patternsFrom(JSON.stringify([{ effect: "no pattern" }, 42, null]))).toBeNull();
    expect(patternsFrom(JSON.stringify([{ effect: "no pattern" }, String.raw`\bok\b`]))).toEqual([
      String.raw`\bok\b`,
    ]);
  });
});
