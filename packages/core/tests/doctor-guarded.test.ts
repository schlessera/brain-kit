/**
 * `brain doctor` runs every check through `guarded`, so one check that throws
 * becomes a `warn` naming its error instead of crashing the whole battery
 * (#465: a missing git binary made the git-hooks check throw and doctor print
 * nothing at all).
 */

import { expect, test } from "bun:test";

import { guarded } from "../src/cli/commands/doctor";

test("a check that throws becomes a warn with its id and message", async () => {
  expect(await guarded("git-hooks", () => { throw new Error('Executable not found in $PATH: "git"'); })).toEqual({
    id: "git-hooks",
    status: "warn",
    detail: 'the check itself failed: Executable not found in $PATH: "git"',
  });
});

test("a rejected async check and a non-Error throw are caught too", async () => {
  expect((await guarded("embeddings", async () => { throw null; })).detail).toBe("the check itself failed: null");
});

test("a check that returns is passed through unchanged", async () => {
  const check = { id: "runtime", status: "pass" as const, detail: "Bun 1.3.14" };
  expect(await guarded("runtime", () => check)).toBe(check);
});
