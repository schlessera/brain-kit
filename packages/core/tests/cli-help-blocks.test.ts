/**
 * `brain --help` and `brain <cmd> --help` for every core command, byte for
 * byte. The snapshot was generated on the tree before core commands loaded
 * lazily (#4793) and committed unchanged, so any change to what help prints
 * or how it exits is a reviewed snapshot diff.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { CORE_COMMAND_WORDS } from "./helpers/core-command-words";

let root: string;
beforeAll(() => { root = makeTempBrain(); });
afterAll(() => cleanup(root));

test("brain --help and every core command's --help print the snapshotted output and exit code", async () => {
  const invocations: string[][] = [["--help"], ...CORE_COMMAND_WORDS.map((word) => [word, "--help"])];
  const outputs: Record<string, { code: number; stdout: string }> = {};
  for (let start = 0; start < invocations.length; start += 8) {
    const batch = invocations.slice(start, start + 8);
    const results = await Promise.all(batch.map((args) => runCli(root, args)));
    batch.forEach((args, i) => { outputs[args.join(" ")] = { code: results[i]!.code, stdout: results[i]!.stdout }; });
  }
  expect(Object.keys(outputs)).toHaveLength(40);
  expect(outputs).toMatchSnapshot();
}, 120_000);
