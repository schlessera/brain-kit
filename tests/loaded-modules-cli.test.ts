/**
 * Which core command modules a `brain` invocation evaluates (#4793). Core
 * commands load lazily: an invocation loads the command table and the one
 * command it runs, and `--version` and `--help` load no command at all.
 * Observed with `tests/helpers/loaded-modules.ts`, so each case proves the load
 * set of the `argv` it ran.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain } from "../packages/core/tests/cli-harness";
import { runLoadedModules } from "./helpers/loaded-modules";

const COMMANDS = "packages/core/src/cli/commands/";

let root: string;
beforeAll(() => { root = makeTempBrain(); });
afterAll(() => cleanup(root));

async function commandModules(...args: string[]): Promise<{ code: number; stdout: string; modules: string[] }> {
  const result = await runLoadedModules([BRAIN_BIN, ...args], { cwd: root, env: keylessEnv(root) });
  return { code: result.code, stdout: result.stdout, modules: result.modules.filter((path) => path.startsWith(COMMANDS)) };
}

describe("brain loads only the core command it runs", () => {
  test("brain read me/identity.md loads read.ts and the table", async () => {
    const result = await commandModules("read", "me/identity.md");
    expect(result.code).toBe(0);
    expect(result.modules).toEqual([`${COMMANDS}index.ts`, `${COMMANDS}read.ts`]);
  });

  test("brain --version loads the table and no command", async () => {
    const result = await commandModules("--version");
    expect(result.code).toBe(0);
    expect(result.modules).toEqual([`${COMMANDS}index.ts`]);
  });

  test("brain --help loads the table and no command", async () => {
    const result = await commandModules("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Commands:");
    expect(result.modules).toEqual([`${COMMANDS}index.ts`]);
  });

  test("brain render --help loads render.ts and the table", async () => {
    const result = await commandModules("render", "--help");
    expect(result.code).toBe(0);
    expect(result.modules).toEqual([`${COMMANDS}index.ts`, `${COMMANDS}render.ts`]);
  });
});
