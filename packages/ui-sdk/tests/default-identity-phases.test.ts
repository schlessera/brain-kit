import { expect, test } from "bun:test";
import { DEFAULT_IDENTITY_PHASES, defaultIdentityPhase } from "./fixtures/default-identity-phases.js";
import { ordinaryIdentityPhases } from "./fixtures/ordinary-identity-phases.js";

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

test("native parent and launcher select the complete existing phase inventory for each composition", () => {
  expect(ordinaryIdentityPhases({})).toEqual(["controls", "fresh", "warm", "strict"]);
  expect(ordinaryIdentityPhases({ sharedGit: true })).toEqual(["fresh", "warm", "strict"]);
  expect(ordinaryIdentityPhases({ sharedGit: true, privateGitInputs: true }))
    .toEqual(["private", "fresh-controls", "fresh-app", "warm", "strict"]);
  expect(ordinaryIdentityPhases({ indexControls: true })).toEqual([undefined]);
  expect(ordinaryIdentityPhases({ sharedGit: true, indexControls: true })).toEqual([undefined]);
  expect(ordinaryIdentityPhases({ sharedGit: true, probeStatePlacement: true })).toEqual(["probe-state"]);
  const application = { sharedGit: true, privateGitInputs: true, applicationQualification: true };
  expect(ordinaryIdentityPhases(application)).toEqual(["private-positive", "fresh-git", "fresh-app", "warm", "strict"]);
  expect(ordinaryIdentityPhases({ ...application, applicationScenario: "governed" }))
    .toEqual(["private-positive", "fresh-git", "fresh-app", "warm"]);
  expect(ordinaryIdentityPhases({ ...application, applicationScenario: "strict" }))
    .toEqual(["private-positive", "fresh-git", "strict"]);
  expect(ordinaryIdentityPhases({ ...application, applicationScenario: "db-repeat" }))
    .toEqual(["private-positive", "fresh-app", "warm"]);
});
