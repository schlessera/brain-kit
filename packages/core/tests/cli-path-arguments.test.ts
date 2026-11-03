/**
 * CLI path arguments (#3422, maintainer ruling of 2026-11-03): an absolute
 * argument inside the brain is converted to a brain-relative path before it
 * reaches `safeResolve`, which itself stays strict. An absolute argument
 * outside the brain is still refused, and so is one that only reaches the
 * outside through a symlink inside the brain. `brain eval --out` and
 * `brain image --out` carry the same rows in their own suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;
let outside: string;

beforeAll(() => {
  root = makeTempBrain();
  outside = mkdtempSync(join(tmpdir(), "brain-cli-path-outside-"));
  writeFileSync(join(outside, "secret.md"), "---\ntitle: Secret\ntype: note\n---\n\nOutside the brain.\n");
  symlinkSync(outside, join(root, "notes", "link-out"));
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

describe("brain read <path>", () => {
  test("an absolute path inside the brain is read", async () => {
    const { code, stdout } = await runCli(root, ["read", join(root, "health", "knee-injury.md")]);
    expect(code).toBe(0);
    expect(stdout).toContain("Left Knee");
  });

  test("an absolute path outside the brain is refused", async () => {
    const { code, stdout, stderr } = await runCli(root, ["read", join(outside, "secret.md")]);
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("Outside the brain");
    expect(stderr).toContain("File not found");
  });

  test("an absolute path through a symlink that leaves the brain is refused", async () => {
    const { code, stdout, stderr } = await runCli(root, ["read", join(root, "notes", "link-out", "secret.md")]);
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("Outside the brain");
    expect(stderr).toContain("File not found");
  });
});

describe("brain archive <path>", () => {
  test("an absolute path inside the brain is archived, reported brain-relative", async () => {
    const { code, stdout } = await runCli(root, ["archive", join(root, "notes", "loose-idea.md"), "--dry-run", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).path).toBe("notes/loose-idea.md");
  });

  test("an absolute path outside the brain, or through a link out of it, is refused", async () => {
    for (const path of [join(outside, "secret.md"), join(root, "notes", "link-out", "secret.md")]) {
      const { code, stderr } = await runCli(root, ["archive", path, "--dry-run", "--json"]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("escapes the brain root");
    }
  });
});

describe("brain okf export --out <dir>", () => {
  test("an absolute directory inside the brain passes containment and is named brain-relative", async () => {
    const { stderr } = await runCli(root, ["okf", "export", "--out", join(root, "okf-abs"), "--json"]);
    // The fixture does not exclude this directory from indexing, so the export
    // stops at that later check, which names the converted relative path.
    expect(stderr).not.toContain("escapes the brain root");
    expect(stderr).toContain("okf-abs.");
  });

  test("an absolute directory outside the brain, or through a link out of it, is refused", async () => {
    for (const out of [join(outside, "okf"), join(root, "notes", "link-out", "okf")]) {
      const { code, stderr } = await runCli(root, ["okf", "export", "--out", out, "--json"]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("escapes the brain root");
      expect(existsSync(join(outside, "okf"))).toBe(false);
    }
  });
});
