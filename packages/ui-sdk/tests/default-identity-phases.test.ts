import { expect, test } from "bun:test";
import { DEFAULT_IDENTITY_PHASES, defaultIdentityPhase } from "./fixtures/default-identity-phases.js";
import { ordinaryIdentityPhases, ordinaryIdentityApplicationTimeoutMs, IDENTITY_PHASE_TIMEOUT_MS, IDENTITY_CLEANUP_TIMEOUT_MS } from "./fixtures/ordinary-identity-phases.js";

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


test("scratch composition partitions every Git/app pair without increasing the total deadline", () => {
  const composition = { sharedGit: true, privateGitInputs: true, applicationQualification: true, scratchMask: true };
  expect(ordinaryIdentityPhases(composition)).toEqual(["private-positive", "fresh-git", "fresh-app", "warm-git", "warm-app", "strict-git", "strict-app"]);
  expect(IDENTITY_PHASE_TIMEOUT_MS).toBe(90_000);
  expect(IDENTITY_CLEANUP_TIMEOUT_MS).toBe(5_000);
  expect(ordinaryIdentityApplicationTimeoutMs(composition), "PARTITION_DOES_NOT_ADD_AN_APPLICATION_BUDGET").toBe(455_000);
  expect(ordinaryIdentityApplicationTimeoutMs({ ...composition, scratchMask: false })).toBe(455_000);
  expect(ordinaryIdentityApplicationTimeoutMs({})).toBe(365_000);
  expect(ordinaryIdentityApplicationTimeoutMs({ sharedGit: true })).toBe(275_000);
});

test("scratch partition cannot select an incomplete or narrowed composition", () => {
  const composition = { sharedGit: true, privateGitInputs: true, applicationQualification: true, scratchMask: true };
  for (const selection of [{ ...composition, sharedGit: false }, { ...composition, privateGitInputs: false },
    { ...composition, applicationQualification: false }, { ...composition, applicationScenario: "governed" as const },
    { ...composition, probeStatePlacement: true }, { ...composition, indexControls: true }])
    expect(() => ordinaryIdentityPhases(selection)).toThrow("Scratch mask partition requires");
});
