/**
 * The exec wrapper, through the pi backend's real tools.
 *
 * The unit tests in `@schlessera/brain-ui-sdk` cover the helpers. These cover
 * the thing that actually matters: that the two tools which spawn — `bash` and
 * `grep` — go through the wrapper when one is configured, spawn exactly as
 * before when one is not, and never hand a wrapper's path to a shell.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeEmptyBrain, resultText } from "./helpers";

const CTX = {} as never;

let previous: string | undefined;
const temps: string[] = [];

beforeEach(() => {
  previous = process.env.BRAIN_UI_EXEC_WRAPPER;
});
afterEach(() => {
  if (previous === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER;
  else process.env.BRAIN_UI_EXEC_WRAPPER = previous;
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/**
 * A wrapper that records the argv it received and then becomes the program,
 * so the tool under test still produces its normal output.
 */
function writeWrapper(name: string): { path: string; argvLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-exec-wrapper-"));
  temps.push(dir);
  const argvLog = join(dir, "argv.log");
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\nexec "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return { path, argvLog };
}

function toolsFor(root: string) {
  const turn = createTurnContext();
  const tools = createBrainTools({
    brain: createBrainAccess(root),
    turn,
    lock: toolLockFromKeyed(createKeyedLock()),
  });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("the bash tool", () => {
  test("runs through the wrapper, which sees bash as an argument", async () => {
    const brain = await makeEmptyBrain();
    const { path, argvLog } = writeWrapper("run-as-brain.sh");
    process.env.BRAIN_UI_EXEC_WRAPPER = path;
    try {
      const res = await toolsFor(brain.root).bash!.execute(
        "t1",
        { command: "echo brain-kit-ok" },
        undefined,
        undefined,
        CTX
      );
      // The command still ran: wrapping is transparent to the tool's contract.
      expect(resultText(res)).toContain("brain-kit-ok");
      // And it ran through the wrapper, with the program unsplit in argv[1].
      expect(readFileSync(argvLog, "utf-8").split("\n").filter(Boolean)).toEqual([
        "bash",
        "-lc",
        "echo brain-kit-ok",
      ]);
    } finally {
      brain.cleanup();
    }
  }, 30_000);

  test("spawns directly when no wrapper is configured", async () => {
    const brain = await makeEmptyBrain();
    const { argvLog } = writeWrapper("unused.sh");
    delete process.env.BRAIN_UI_EXEC_WRAPPER;
    try {
      const res = await toolsFor(brain.root).bash!.execute(
        "t2",
        { command: "echo brain-kit-ok" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(res)).toContain("brain-kit-ok");
      // Nothing was recorded, because nothing was wrapped. This is the path
      // every existing deployment is on and it has to stay untouched.
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      brain.cleanup();
    }
  }, 30_000);

  test("a wrapper path full of shell metacharacters is never re-split", async () => {
    const brain = await makeEmptyBrain();
    // If ANY layer between here and execve treated this as a command line,
    // the `touch` would run and the `&&` would change what executes.
    const { path, argvLog } = writeWrapper("wrap; touch pwned && echo no.sh");
    process.env.BRAIN_UI_EXEC_WRAPPER = path;
    try {
      const res = await toolsFor(brain.root).bash!.execute(
        "t3",
        { command: "echo still-fine" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(res)).toContain("still-fine");
      expect(readFileSync(argvLog, "utf-8").split("\n").filter(Boolean)).toEqual([
        "bash",
        "-lc",
        "echo still-fine",
      ]);
      expect(existsSync(join(brain.root, "pwned"))).toBe(false);
      expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
    } finally {
      brain.cleanup();
    }
  }, 30_000);
});

describe("the grep tool", () => {
  test("runs through the wrapper too", async () => {
    const brain = await makeEmptyBrain();
    writeFileSync(join(brain.root, "hit.md"), "needle in here\n");
    const { path, argvLog } = writeWrapper("run-as-brain.sh");
    process.env.BRAIN_UI_EXEC_WRAPPER = path;
    try {
      const res = await toolsFor(brain.root).grep!.execute(
        "t4",
        { pattern: "needle" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(res)).toContain("needle");
      expect(readFileSync(argvLog, "utf-8").split("\n").filter(Boolean)).toEqual([
        "grep",
        "-rInE",
        "--",
        "needle",
        ".",
      ]);
    } finally {
      brain.cleanup();
    }
  }, 30_000);
});
