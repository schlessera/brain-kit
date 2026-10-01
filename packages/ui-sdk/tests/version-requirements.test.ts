import { describe, expect, test } from "bun:test";
import {
  assertVersionRequirements,
  validateVersionMinimum,
  type VersionRequirement,
} from "../src/server/version-requirements";

const minimum = (declaration: string): VersionRequirement => ({ owner: "host versionRequirements", kind: "minimum", declaration });
const range = (declaration: string, owner = "backend package"): VersionRequirement => ({ owner, kind: "range", declaration });
const check = (version: string | null, requirements: VersionRequirement[]) => assertVersionRequirements({
  identity: "fixture-sdk", version, requirements, phase: "startup", action: "Install a compatible fixture SDK.", unknownReason: "manifest unavailable",
});

describe("strict version declarations", () => {
  for (const value of ["", " ", "1", "1.2", "v1.2.3", "=1.2.3", ">=1.2.3", "01.2.3", "1.2.3-01", "1.2.3-..", "1.2.3\u00a0", "1.2.3 garbage", undefined, 123]) {
    test(`rejects minimum ${JSON.stringify(value)}`, () => {
      expect(() => validateVersionMinimum(value, "host", "fixture-sdk")).toThrow("host");
    });
  }
  for (const value of ["1.2.3", "1.2.3-beta.1", "1.2.3+build.8", "1.2.3-beta.1+build.8"]) {
    test(`accepts full minimum ${value}`, () => expect(validateVersionMinimum(value, "host", "fixture-sdk")).toBe(value));
  }
  for (const declaration of ["", " ", "garbage", "^1.2.3 garbage", "^1.2.3\u00a0"]) {
    test(`rejects complete malformed range ${JSON.stringify(declaration)}`, () => expect(() => check("1.2.4", [range(declaration)])).toThrow("Invalid"));
  }
});

describe("composition retains every original constraint", () => {
  test("a stronger host minimum refuses a version allowed by the package", () => {
    expect(() => check("1.3.0", [range("^1.2.3"), minimum("1.4.0")])).toThrow("host versionRequirements");
  });
  test("a weaker host minimum preserves the package floor", () => {
    expect(() => check("1.2.2", [range("^1.2.3"), minimum("1.0.0")])).toThrow("backend package");
  });
  test("the package upper bound is never replaced by the host floor", () => {
    expect(() => check("2.1.0", [range("^1.2.3"), minimum("1.4.0")])).toThrow("^1.2.3");
  });
  test("an empty intersection names both owners and original declarations", () => {
    let message = "";
    try { check("3.0.0", [range("^1.2.3"), minimum("2.0.0")]); } catch (error) { message = String(error); }
    for (const text of ["No version", "fixture-sdk", "backend package", "^1.2.3", "host versionRequirements", "2.0.0", "3.0.0", "startup", "Install a compatible"]) expect(message).toContain(text);
  });
  test("OR members keep their original grouping", () => {
    const declarations = [range("^1.2.3 || ^3.0.0"), minimum("2.0.0")];
    expect(() => check("3.1.0", declarations)).not.toThrow();
    expect(() => check("2.1.0", declarations)).toThrow("incompatible");
    expect(() => check("1.9.0", declarations)).toThrow("incompatible");
  });
  test("three pairwise-overlapping unions can still have an empty full intersection", () => {
    expect(() => check("1.0.0", [range("1.0.0 || 2.0.0", "A"), range("2.0.0 || 3.0.0", "B"), range("1.0.0 || 3.0.0", "C")])).toThrow("No version");
  });
  test("build metadata does not change precedence", () => expect(() => check("1.4.0+other", [range("^1.2.3"), minimum("1.4.0+host")])).not.toThrow());
  test("ordinary stable ranges exclude newer prereleases", () => expect(() => check("1.5.0-beta.1", [range("^1.2.3"), minimum("1.4.0")])).toThrow("incompatible"));
  test("a prerelease minimum opts in only its tuple", () => {
    expect(() => check("1.4.0-beta.2", [range(">=1.4.0-beta.1 <2"), minimum("1.4.0-beta.1")])).not.toThrow();
    expect(() => check("1.5.0-beta.1", [range(">=1.4.0-beta.1 <2"), minimum("1.4.0-beta.1")])).toThrow("incompatible");
  });
  test("one declaration's prerelease opt-in cannot leak into another", () => {
    expect(() => check("1.4.0-beta.2", [range("^1.2.3"), minimum("1.4.0-beta.1")])).toThrow("incompatible");
    expect(() => check("1.4.0", [range("^1.2.3"), minimum("1.4.0-beta.1")])).not.toThrow();
  });
  test("detects an intersection consisting only of an allowed prerelease interval", () => {
    expect(() => check("1.0.1-0", [range(">1.0.0 <1.0.1-alpha"), range(">=1.0.1-0 <1.0.1-alpha")])).not.toThrow();
  });
  test("a prerelease-only interval conflicts with an ordinary stable requirement", () => expect(() => check("1.4.0-beta.2", [range(">=1.4.0-beta.1 <1.4.0"), range("^1.2.3")])).toThrow("No version"));
  test("unknown actual versions fail with context", () => {
    expect(() => check(null, [minimum("1.2.3")])).toThrow("manifest unavailable");
    expect(() => check("garbage", [minimum("1.2.3")])).toThrow("unknown");
  });
});
