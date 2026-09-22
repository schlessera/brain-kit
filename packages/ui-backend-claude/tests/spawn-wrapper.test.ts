/**
 * The SDK spawn hook. Real processes, because what is being claimed here is
 * that an aborted turn actually dies — and the adapter around node's
 * ChildProcess is exactly the kind of code that typechecks while doing nothing.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createWrappedSpawn } from "../src/spawn-wrapper";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the wrapper receives the SDK's command as an argument, and abort kills the group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-spawn-wrapper-"));
  temps.push(dir);
  const argvLog = join(dir, "argv.log");
  const childPidFile = join(dir, "child.pid");

  // Supervises rather than execs, so there is a group to prove something
  // about — the shape a privilege-dropping wrapper actually has.
  const wrapper = join(dir, "supervise.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\n"$@" &\necho $! > '${childPidFile}'\nwait\n`,
    { mode: 0o755 }
  );
  chmodSync(wrapper, 0o755);

  const spawn = createWrappedSpawn({ wrapper });
  const proc = spawn({
    command: "sleep",
    args: ["300"],
    cwd: dir,
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  });

  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));

  const deadline = Date.now() + 10_000;
  while (!existsSync(childPidFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const childPid = Number(readFileSync(childPidFile, "utf-8").trim());
  expect(alive(childPid)).toBe(true);

  // argv[0] is the wrapper; the SDK's command and args follow it unsplit.
  expect(readFileSync(argvLog, "utf-8").split("\n").filter(Boolean)).toEqual([
    "sleep",
    "300",
  ]);

  // The SDK interface: streams present, lifecycle delegated.
  expect(proc.stdin).toBeTruthy();
  expect(proc.stdout).toBeTruthy();
  expect(proc.exitCode).toBeNull();

  expect(proc.kill("SIGTERM")).toBe(true);
  await exited;

  // The grandchild is what a kill of the wrapper alone would have left behind.
  const gone = Date.now() + 10_000;
  while (alive(childPid) && Date.now() < gone) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(alive(childPid)).toBe(false);
  expect(proc.killed).toBe(true);
}, 30_000);
