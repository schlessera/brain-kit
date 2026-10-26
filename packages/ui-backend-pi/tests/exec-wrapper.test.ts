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

function toolsFor(root: string, exec?: { wrapper?: string; killer?: string }) {
  const turn = createTurnContext();
  const tools = createBrainTools({
    brain: createBrainAccess(root),
    exec,
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
        // Absolute, so the helper can execv it and PATH cannot choose which
        // bash runs.
        Bun.which("bash")!,
        "--noprofile",
        "--norc",
        "-c",
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
        Bun.which("bash")!,
        "--noprofile",
        "--norc",
        "-c",
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
        Bun.which("grep")!,
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

test("host A/C and explicit empty override ambient B for both Pi spawn tools (#1429)", async () => {
  const brain = await makeEmptyBrain();
  const a = writeWrapper("host-a"), b = writeWrapper("ambient-b"), c = writeWrapper("host-c");
  process.env.BRAIN_UI_EXEC_WRAPPER = b.path;
  writeFileSync(join(brain.root, "hit.md"), "needle");
  try {
    for (const tool of ["bash", "grep"] as const) {
      for (const wrapper of [a, c]) {
        const result = await toolsFor(brain.root, { wrapper: wrapper.path })[tool]!.execute(
          "host", tool === "bash" ? { command: "echo needle" } : { pattern: "needle" },
          undefined, undefined, CTX);
        expect(resultText(result)).toContain("needle");
        expect(existsSync(wrapper.argvLog), "HOST_WRAPPER_SELECTED").toBe(true);
      }
      await toolsFor(brain.root, {})[tool]!.execute(
        "empty", tool === "bash" ? { command: "echo needle" } : { pattern: "needle" },
        undefined, undefined, CTX);
      expect(existsSync(b.argvLog), "EXPLICIT_EMPTY_NOT_AMBIENT").toBe(false);
    }
    expect(readFileSync(a.argvLog, "utf8").split("\n").filter(Boolean)).toEqual([
      Bun.which("bash")!, "--noprofile", "--norc", "-c", "echo needle", Bun.which("grep")!, "-rInE", "--", "needle", ".",
    ]);
    expect(readFileSync(c.argvLog, "utf8")).toBe(readFileSync(a.argvLog, "utf8"));
  } finally { brain.cleanup(); }
});
