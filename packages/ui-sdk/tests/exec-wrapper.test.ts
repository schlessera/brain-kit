/**
 * The exec wrapper seam. Two of these are unit tests over pure functions; the
 * last one spawns real processes, because "abort kills the process group" is
 * not a property an argv array can demonstrate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EXEC_WRAPPER_ENV,
  execWrapperSpawnOptions,
  killWrapped,
  validateExecWrapper,
  wrapCommand,
} from "../src/server/exec-wrapper";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "exec-wrapper-"));
  temps.push(dir);
  return dir;
}

describe("with no wrapper configured, nothing changes", () => {
  test("wrapCommand is the identity and the spawn options are empty", () => {
    expect(wrapCommand(["grep", "-rInE", "--", "x", "."])).toEqual([
      "grep",
      "-rInE",
      "--",
      "x",
      ".",
    ]);
    // Spread into a Bun.spawn options object, this has to add no keys at all:
    // `detached: undefined` is not the same spawn as no `detached` at all.
    expect(execWrapperSpawnOptions()).toEqual({});
    expect(Object.keys(execWrapperSpawnOptions())).toEqual([]);
  });

  test("an unset, empty or whitespace value all mean no wrapper", () => {
    expect(validateExecWrapper(undefined)).toBeUndefined();
    expect(validateExecWrapper("")).toBeUndefined();
    expect(validateExecWrapper("   ")).toBeUndefined();
  });
});

describe("a wrapper is a path, not a command line", () => {
  test("it becomes argv[0] and the program stays a separate element", () => {
    expect(wrapCommand(["bash", "-lc", "echo hi"], "/opt/run-as-brain")).toEqual([
      "/opt/run-as-brain",
      "bash",
      "-lc",
      "echo hi",
    ]);
  });

  test("a prefix with arguments is refused, because refusing is the whole defence", () => {
    // The injection this seam has to not have: if a wrapper could be
    // "sudo -u brain", something would have to split it, and splitting is
    // where an attacker-controlled value becomes an attacker-controlled
    // command. A path cannot be split.
    for (const bad of ["sudo -u brain", "run-as-brain", "./wrapper", "x; rm -rf /"]) {
      expect(() => validateExecWrapper(bad)).toThrow(/absolute path/);
    }
  });

  test("an absolute path full of metacharacters is a filename, not a script", () => {
    // Accepted, because it IS a legal filename — and harmless, because it is
    // only ever an argv element. The functional proof is in the pi backend's
    // suite, where a wrapper named like this actually runs.
    const nasty = "/tmp/wrap; touch /tmp/pwned";
    expect(validateExecWrapper(nasty)).toBe(nasty);
    expect(wrapCommand(["echo", "hi"], nasty)[0]).toBe(nasty);
  });
});

describe("aborting a wrapped spawn kills the process group", () => {
  test("the wrapper and the process it started both die", async () => {
    const dir = tempDir();
    const argvLog = join(dir, "argv.log");
    const childPidFile = join(dir, "child.pid");

    // Not `exec "$@"`: the wrapper has to STAY ALIVE with a child of its own,
    // or there is no group to prove anything about. This is the shape a real
    // privilege-dropping wrapper has — it supervises what it started.
    const wrapper = join(dir, "supervise.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\n"$@" &\necho $! > '${childPidFile}'\nwait\n`,
      { mode: 0o755 }
    );
    chmodSync(wrapper, 0o755);

    const proc = Bun.spawn(wrapCommand(["sleep", "300"], wrapper), {
      stdout: "ignore",
      stderr: "ignore",
      ...execWrapperSpawnOptions(wrapper),
    });

    // Wait for the wrapper to have started its child.
    const deadline = Date.now() + 10_000;
    while (!existsSync(childPidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const childPid = Number(
      (await Bun.file(childPidFile).text()).trim()
    );
    expect(Number.isInteger(childPid)).toBe(true);
    expect(alive(childPid)).toBe(true);

    // The wrapper saw the program as its own argument, unsplit.
    expect((await Bun.file(argvLog).text()).split("\n").filter(Boolean)).toEqual([
      "sleep",
      "300",
    ]);

    killWrapped(proc, wrapper);
    await proc.exited;

    // The grandchild is what a plain `proc.kill()` would have left running.
    const gone = Date.now() + 10_000;
    while (alive(childPid) && Date.now() < gone) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(alive(childPid)).toBe(false);
  }, 30_000);

  test("without a wrapper it is the plain kill it always was", async () => {
    const proc = Bun.spawn(wrapCommand(["sleep", "300"]), {
      stdout: "ignore",
      stderr: "ignore",
      ...execWrapperSpawnOptions(),
    });
    killWrapped(proc);
    await proc.exited;
    expect(alive(proc.pid)).toBe(false);
  }, 30_000);
});

test("the environment variable name is the one the packages document", () => {
  expect(EXEC_WRAPPER_ENV).toBe("BRAIN_UI_EXEC_WRAPPER");
});

/** `kill -0`: is this pid still there? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
