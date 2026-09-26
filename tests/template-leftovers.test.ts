/**
 * The brain template's `.gitignore` ignores every tool leftover that
 * `brain sync assess` classifies as ARTIFACT and `brain doctor` reports when
 * committed, so a new brain never commits one in the first place.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { TOOL_LEFTOVER_PATTERNS } from "../packages/core/src/lib/tool-leftovers";

test("template/.gitignore has a line for every tool-leftover pattern", () => {
  const lines = new Set(
    readFileSync(resolve(import.meta.dir, "..", "template", ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim())
  );
  expect(TOOL_LEFTOVER_PATTERNS.length).toBeGreaterThan(10);
  expect(TOOL_LEFTOVER_PATTERNS.filter((pattern) => !lines.has(pattern))).toEqual([]);
});
