/**
 * The shared fake `brain` CLI (#4839): it runs under this test's own Bun
 * whatever the fixture's PATH holds, and answers the boot probe with the
 * host's minimum version unless told otherwise.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tempDirs } from "../../../tests/helpers/temp";
import { MIN_BRAIN_CLI_VERSION } from "../src/brain/client.js";
import { installFakeBrain } from "./helpers/fake-brain-cli";

const tempDir = tempDirs();

/** Run the fake with a PATH that holds no `bun` at all. */
function runWithoutBunOnPath(bin: string, ...args: string[]) {
  const child = Bun.spawnSync([bin, ...args], { env: { PATH: tempDir("odysseus-empty-path-") }, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("the fake runs under this test's Bun and answers --version with the minimum, with no bun on PATH", () => {
  const root = tempDir("odysseus-fake-brain-");
  const bin = installFakeBrain(root);
  expect(bin).toBe(join(root, "node_modules", ".bin", "brain"));
  const version = runWithoutBunOnPath(bin, "--version");
  expect(version.code, version.stderr).toBe(0);
  expect(version.stdout.trim()).toBe(MIN_BRAIN_CLI_VERSION);
  expect(readFileSync(bin, "utf8").split("\n")[0]).toBe(`#!${process.execPath}`);
});

test("a version override answers --version with that version instead", () => {
  const bin = installFakeBrain(tempDir("odysseus-fake-brain-"), { version: "0.40.0" });
  const version = runWithoutBunOnPath(bin, "--version");
  expect(version.code, version.stderr).toBe(0);
  expect(version.stdout.trim()).toBe("0.40.0");
});

test("the argv log records each call's arguments, and the body answers the rest", () => {
  const root = tempDir("odysseus-fake-brain-");
  const log = join(root, "argv.jsonl");
  const bin = installFakeBrain(root, { argvLog: log, body: 'console.log(JSON.stringify({ command: args[0] }));' });
  const search = runWithoutBunOnPath(bin, "search", "Ithaca", "--json");
  expect(search.code, search.stderr).toBe(0);
  expect(JSON.parse(search.stdout)).toEqual({ command: "search" });
  expect(runWithoutBunOnPath(bin, "--version").stdout.trim()).toBe(MIN_BRAIN_CLI_VERSION);
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([["search", "Ithaca", "--json"], ["--version"]]);
});
