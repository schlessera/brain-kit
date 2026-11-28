/**
 * The self-test of `tests/helpers/loaded-modules.ts`. It re-establishes, on the
 * Bun this repository runs, each fact the helper's callers rely on, so that a
 * Bun upgrade that changes one fails here rather than in a load-cost test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchdogMs } from "../scripts/test-deadlines";
import { runLoadedModules } from "./helpers/loaded-modules";
import { tempDirs } from "./helpers/temp";

const FIXTURE = "tests/fixtures/loaded-modules";
const ENTRY = `${FIXTURE}/entry.ts`;
const cwd = `${import.meta.dir}/..`;
const env = { PATH: process.env.PATH ?? "" };

const run = (...args: string[]) => runLoadedModules([ENTRY, ...args], { cwd, env });
const tempDir = tempDirs();
const zodPaths = (modules: string[]) => modules.filter((path) => path.includes("node_modules/zod/"));

describe("runLoadedModules", () => {
  test("lists a static dependency and the entry of a run that returns", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("static true\n");
    expect(result.modules).toContain(`${FIXTURE}/static-dep.ts`);
    expect(result.modules).toContain(ENTRY);
  });

  test("lists the files of an installed package", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(zodPaths(result.modules).length).toBeGreaterThan(0);
  });

  test("lists a module reached by import() only on the run that imports it", async () => {
    const plain = await run();
    expect(plain.code).toBe(0);
    expect(plain.modules).toContain(`${FIXTURE}/static-dep.ts`);
    expect(plain.modules).not.toContain(`${FIXTURE}/lazy-dep.ts`);

    const lazy = await run("lazy");
    expect(lazy.code).toBe(0);
    expect(lazy.stdout).toBe("static lazy true\n");
    expect(lazy.modules).toContain(`${FIXTURE}/lazy-dep.ts`);
  });

  test("leaves out a module imported with import type and one whose import is used only as a type", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.modules).toContain(`${FIXTURE}/static-dep.ts`);
    expect(result.modules).not.toContain(`${FIXTURE}/type-only-dep.ts`);
    expect(result.modules).not.toContain(`${FIXTURE}/type-used-dep.ts`);
  });

  test("still reports after process.exit(1), without the entry whose evaluation did not complete", async () => {
    const result = await run("exit");
    expect(result.code).toBe(1);
    expect(result.modules).toContain(`${FIXTURE}/static-dep.ts`);
    expect(zodPaths(result.modules).length).toBeGreaterThan(0);
    expect(result.modules).not.toContain(ENTRY);
  });

  test("passes only the environment the caller gives", async () => {
    const result = await runLoadedModules(["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"], {
      cwd,
      env: { PATH: env.PATH, TZ: "UTC" },
    });
    expect(result.code).toBe(0);
    // The test preload adds its own keys to every child it sees spawned; the
    // parent's own home must not reach the child.
    const keys = JSON.parse(result.stdout) as string[];
    expect(process.env.HOME).toBeDefined();
    expect(keys).toEqual(expect.arrayContaining(["PATH", "TZ"]));
    expect(keys).not.toContain("HOME");
  });

  test("writes stdin content to the child", async () => {
    const result = await runLoadedModules(["-e", "process.stdout.write(await Bun.stdin.text())"], { cwd, env, stdin: "hello" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  test("kills a child that never exits and rejects naming its argv", async () => {
    const failure = await runLoadedModules([ENTRY, "hang"], { cwd, env, watchdog: 1_000 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`bun ${ENTRY} hang`);
    const pid = Number(/\(pid (\d+)\)/.exec(message)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  test("kills a child that never reads a stdin larger than the pipe buffer, within the watchdog", async () => {
    // Several pipe buffers of input to a child that never reads its stdin.
    const run = runLoadedModules([ENTRY, "hang"], { cwd, env, watchdog: 1_000, stdin: "Ithaca ".repeat(1 << 20) }).then(
      () => null,
      (error: unknown) => error,
    );
    const failure = await Promise.race([run, Bun.sleep(watchdogMs(15_000)).then(() => "still waiting on the stdin write")]);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`bun ${ENTRY} hang`);
    expect(message).toContain("was killed");
  }, watchdogMs(30_000));

  test("settles within the watchdog when a descendant still holds the child's output open", async () => {
    const pidFile = join(tempDir("odysseus-loaded-modules-"), "descendant.pid");
    // The child starts a descendant that inherits its stdout and stderr, then exits.
    const script = [
      `const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });`,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));`,
      `descendant.unref();`,
    ].join("\n");
    const run = runLoadedModules(["-e", script], { cwd, env, watchdog: 1_000 }).then(
      () => null,
      (error: unknown) => error,
    );
    let descendant: number | undefined;
    try {
      const failure = await Promise.race([run, Bun.sleep(watchdogMs(15_000)).then(() => "still waiting on the held output")]);
      descendant = Number(readFileSync(pidFile, "utf8"));
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("bun -e");
      expect(message).toContain("exited 0, but its output was still held open");
      // It settled while the descendant was still running, not when it exited.
      expect(() => process.kill(descendant!, 0)).not.toThrow();
    } finally {
      if (descendant) process.kill(descendant, "SIGKILL");
    }
  }, watchdogMs(30_000));
});
