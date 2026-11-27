/**
 * The self-test of `tests/helpers/loaded-modules.ts`. It re-establishes, on the
 * Bun this repository runs, each fact the helper's callers rely on, so that a
 * Bun upgrade that changes one fails here rather than in a load-cost test.
 */
import { describe, expect, test } from "bun:test";
import { runLoadedModules } from "./helpers/loaded-modules";

const FIXTURE = "tests/fixtures/loaded-modules";
const ENTRY = `${FIXTURE}/entry.ts`;
const cwd = `${import.meta.dir}/..`;
const env = { PATH: process.env.PATH ?? "" };

const run = (...args: string[]) => runLoadedModules([ENTRY, ...args], { cwd, env });
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
});
