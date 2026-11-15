import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXPECTED_FAILURE_PREFIX } from "../scripts/expected-failure-log";
import { failingLines } from "../scripts/pr-status";

const ROOT = join(import.meta.dir, "..");

// A control that fails the way runtime_host's retained-namespace control does:
// both streams, chunks split mid-line, a last line without a newline, exit 1.
const CONTROL = [
  'process.stdout.write(\'{"kind": "command", "code": 1, "stderr": "error: NATIVE_AUTOMATIC_INDEX_COMPLETED: \');',
  "await Bun.sleep(20);",
  'process.stdout.write(\'AbortError [ABORT_ERR]"}\\nNative pi uid 0 hosted proof artifacts: run-pi-uid0-Ithaca\\n\');',
  'process.stderr.write("error: Native hosted proof failed (1); inspect run-pi-uid0-Ithaca.\\nat Ogygia");',
  "process.exit(1);",
].join("\n");

test("a negative control's every line is marked on both streams, and its exit code is returned", async () => {
  const parent = Bun.spawn([process.execPath, "-e", [
    `import { runExpectedFailureControl } from ${JSON.stringify(join(ROOT, "scripts/expected-failure-log.ts"))};`,
    `const code = await runExpectedFailureControl([process.execPath, "-e", ${JSON.stringify(CONTROL)}]);`,
    'console.log(`error: the control exited ${code}`);',
  ].join("\n")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(parent.stdout).text(), new Response(parent.stderr).text(), parent.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout.split("\n")).toEqual([
    `${EXPECTED_FAILURE_PREFIX}{"kind": "command", "code": 1, "stderr": "error: NATIVE_AUTOMATIC_INDEX_COMPLETED: AbortError [ABORT_ERR]"}`,
    `${EXPECTED_FAILURE_PREFIX}Native pi uid 0 hosted proof artifacts: run-pi-uid0-Ithaca`,
    // The parent's own verdict stays plain.
    "error: the control exited 1",
    "",
  ]);
  expect(stderr.split("\n")).toEqual([
    `${EXPECTED_FAILURE_PREFIX}error: Native hosted proof failed (1); inspect run-pi-uid0-Ithaca.`,
    `${EXPECTED_FAILURE_PREFIX}at Ogygia`,
    "",
  ]);
  // What `pr-status --failures` prints from that log: the verdict, not the control.
  expect(failingLines(`${stdout}${stderr}`)).toEqual(["error: the control exited 1", "(2 lines of a deliberate expected-failure control left out)"]);
});

test("the hosted native proof runs its retained-namespace control through the marked relay", () => {
  const source = readFileSync(join(ROOT, "scripts/prove-native-host.ts"), "utf8");
  expect(source).toContain('await runExpectedFailureControl([process.execPath, import.meta.filename, "--backend=pi", "--app-uid=0", "--retain-index-namespace"])');
  expect(source).not.toMatch(/Bun\.spawn\(\[process\.execPath, import\.meta\.filename, "--backend=pi", "--app-uid=0", "--retain-index-namespace"\]/);
});
