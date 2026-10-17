import { expect, test } from "bun:test";
import { DEFAULT_IDENTITY_PHASES, defaultIdentityPhase } from "./fixtures/default-identity-phases.js";

test("default native proof keeps every control and fresh/warm/strict app phase", () => {
  expect(DEFAULT_IDENTITY_PHASES, "DEFAULT_NATIVE_FULL_PHASE_INVENTORY").toEqual(["controls", "fresh", "warm", "strict"]);
  expect(defaultIdentityPhase([])).toBeUndefined();
  for (const phase of DEFAULT_IDENTITY_PHASES)
    expect(defaultIdentityPhase(["--child", `--default-phase=${phase}`])).toBe(phase);
});
test("default phase requests cannot select foreign, duplicate, parent or shared compositions", () => {
  for (const args of [["--child", "--default-phase=unknown"], ["--default-phase=fresh"],
    ["--child", "--default-phase=fresh", "--default-phase=warm"], ["--child", "--shared-git", "--default-phase=fresh"]])
    expect(() => defaultIdentityPhase(args)).toThrow("Invalid default identity fixture phase");
});
