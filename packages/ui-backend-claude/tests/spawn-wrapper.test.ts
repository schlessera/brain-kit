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

/**
 * The pid the wrapper wrote, once it has written one. The shell creates the
 * file when it opens the redirect and writes the pid after, so a file that
 * exists can still be empty — and `Number("")` is 0, which `kill(0, 0)`
 * reports alive for as long as this test's own process group lives.
 */
async function childPidFrom(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
    if (/^[1-9]\d*$/.test(text)) return Number(text);
    if (Date.now() > deadline) throw new Error(`no pid in ${path} after 10 s`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

  const childPid = await childPidFrom(childPidFile);
  expect(alive(childPid)).toBe(true);

  // argv[0] is the wrapper; the SDK's command and args follow it unsplit, with
  // the command resolved absolute — the SDK hands over a bare `bun` or `node`
  // whenever the CLI is JavaScript, and a wrapper that execs cannot look that
  // up on PATH.
  expect(readFileSync(argvLog, "utf-8").split("\n").filter(Boolean)).toEqual([
    Bun.which("sleep")!,
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

test("a missing cancellation helper is reported, not thrown at the event loop", async () => {
  // node's spawn reports a missing executable ASYNCHRONOUSLY. With no 'error'
  // listener the event is thrown, which takes the server down — cancelling a
  // turn would crash the process rather than fall back to a plain signal.
  const dir = mkdtempSync(join(tmpdir(), "claude-killer-"));
  temps.push(dir);
  const wrapper = join(dir, "exec.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec "$@"\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);

  const spawn = createWrappedSpawn({ wrapper, killer: join(dir, "not-here") });
  const proc = spawn({
    command: "sleep",
    args: ["300"],
    cwd: dir,
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  });
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));

  const errors: unknown[] = [];
  const onUncaught = (error: unknown) => errors.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    expect(proc.kill("SIGTERM")).toBe(true);
    // Let the async spawn error land, then the fallback.
    await exited;
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    process.off("uncaughtException", onUncaught);
  }

  expect(errors).toEqual([]);
  expect(proc.killed).toBe(true);
}, 30_000);
