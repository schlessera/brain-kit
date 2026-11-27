/** The shared git helper of the repository scripts (#4730), against a temporary repository. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitResult } from "../scripts/lib/git";

let root = "";
const ITHACA = "Itháka.md";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "scripts-git-"));
  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  git(root, ["init", "-q"], { env });
  writeFileSync(join(root, ITHACA), "home\n");
  git(root, ["add", "."], { env });
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test("stdout is raw by default and trimmed on request", () => {
  expect(git(root, ["rev-parse", "--is-inside-work-tree"]), "RAW_STDOUT").toBe("true\n");
  expect(git(root, ["rev-parse", "--is-inside-work-tree"], { trim: true }), "TRIMMED_STDOUT").toBe("true");
});

test("a non-zero exit throws the default message unless its code is allowed", () => {
  expect(() => git(root, ["rev-parse", "--verify", "--quiet", "odysseus"]), "DEFAULT_MESSAGE").toThrow("git rev-parse --verify --quiet odysseus failed (1): ");
  expect(git(root, ["rev-parse", "--verify", "--quiet", "odysseus"], { allow: [0, 1] }), "ALLOWED_CODE_RETURNS").toBe("");
  expect(() => git(root, ["cat-file", "-p", "odysseus"], { error: "Cannot read the chart: " }), "PREFIX_MESSAGE").toThrow(/^Cannot read the chart: fatal: /);
  expect(gitResult(root, ["rev-parse", "--verify", "--quiet", "odysseus"]), "RESULT_DOES_NOT_THROW").toEqual({ code: 1, stdout: "", stderr: "" });
});

test("input reaches stdin", () => {
  const text = git(root, ["hash-object", "--stdin"], { input: "Odysseus\n", trim: true });
  expect(text, "STDIN_TEXT_HASHED").not.toBe(git(root, ["hash-object", "--stdin"], { trim: true }));
  expect(git(root, ["hash-object", "--stdin"], { input: new TextEncoder().encode("Odysseus\n"), trim: true }), "STDIN_BYTES_HASHED").toBe(text);
});

test("quotePath: false returns a non-ASCII path unquoted", () => {
  expect(git(root, ["ls-files"]), "QUOTED_BY_DEFAULT").toBe('"Ith\\303\\241ka.md"\n');
  expect(git(root, ["ls-files"], { quotePath: false }), "UNQUOTED_PATH").toBe(`${ITHACA}\n`);
});

test("optionalLocks: false sets GIT_OPTIONAL_LOCKS=0 in the child's environment", () => {
  const probe = ["-c", "alias.locks=!printenv GIT_OPTIONAL_LOCKS || echo unset", "locks"];
  expect(git(root, probe, { env: { GIT_OPTIONAL_LOCKS: "" }, trim: true }), "UNSET_BY_DEFAULT").not.toBe("0");
  expect(git(root, probe, { optionalLocks: false, trim: true }), "OPTIONAL_LOCKS_OFF").toBe("0");
});

test("chdir: flag runs git -C, so an unreachable root fails inside git", () => {
  expect(() => git(join(root, "missing"), ["status"], { chdir: "flag", error: (_args, code, stderr) => `failed ${code}: ${stderr}` }), "GIT_REPORTS_MISSING_ROOT")
    .toThrow(/^failed 128: fatal: cannot change to/);
});

test("encoding: buffer returns the bytes", () => {
  expect(git(root, ["cat-file", "-p", `:${ITHACA}`], { encoding: "buffer" }).toString(), "BUFFER_OUTPUT").toBe("home\n");
});
