import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { maintainModuleStore, moduleMaintenanceExecution, moduleMaintenanceRequested } from "../src/brain/module-maintenance.js";
import { brainCliCommand } from "../src/brain/client.js";
import { currentModuleGeneration, moduleLockHash } from "../../ui-sdk/src/server/module-store.js";
import type { WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-module-maintenance-")), brain = join(root, "brain"), store = join(root, "modules");
  fs.mkdirSync(brain); fs.mkdirSync(store);
  fs.writeFileSync(join(brain, "package.json"), '{"name":"odysseus"}'); fs.writeFileSync(join(brain, "bun.lock"), "Odysseus lock 1");
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const info = Reflect.apply(original, fs, args);
    return args[0] === brain && args[1]?.bigint ? { ...info, dev: 99n, ino: 256n, isDirectory: () => true } : info;
  }) as typeof fs.lstatSync); cleanup.push(() => stat.mockRestore());
  const actual = fs.statfsSync(brain), statfs = spyOn(fs, "statfsSync").mockReturnValue({ ...actual, type: 0x9123683e }); cleanup.push(() => statfs.mockRestore());
  let failure: "tracked" | "install" | "validation" | undefined;
  const run = spyOn(moduleMaintenanceExecution, "run").mockImplementation(async command => {
    const installing = command.command.includes("install"), tracking = command.command[0] === "/usr/bin/git";
    if (failure === "tracked" && tracking || failure === "install" && installing || failure === "validation" && !installing && !tracking) return { exitCode: 1, stdout: "", stderr: "Odysseus deliberate failure" };
    if (installing) {
      const dir = command.command[command.command.indexOf("--cwd") + 1]!;
      fs.mkdirSync(join(dir, "node_modules/.bin"), { recursive: true }); fs.writeFileSync(join(dir, "node_modules/.bin/brain"), "Odysseus CLI");
      expect(command.credentials).toBe(true); expect(command.env).toEqual({ PATH: "/usr/bin:/bin" }); expect(command.home).toBeUndefined();
      expect(command.command).toContain("--frozen-lockfile"); expect(command.command).toContain("--backend=copyfile");
    }
    return { exitCode: 0, stdout: "Odysseus", stderr: "" };
  }); cleanup.push(() => run.mockRestore());
  const command = { brainPath: brain, env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "fixture-secret" }, credentials: false, command: ["brain", "maintain"] };
  const view = { brain, root: brain } as WorkerStartupView;
  return { brain, store, command, view, run, fail(value: typeof failure) { failure = value; } };
}
test("first scheduled maintenance installs, validates, receipts and activates; unchanged lock skips installation", async () => {
  const f = fixture();
  const first = await maintainModuleStore(f.brain, f.view, f.command, "scheduled maintain");
  expect(first.result, "FIRST_MAINTENANCE_ACTIVATES_GENERATION").toBe("activated");
  expect(brainCliCommand(f.brain), "HOST_CLI_LOOKUP_USES_STORE_WITHOUT_OLD_MODULE_DIRECTORY").toEqual([join(f.brain, "node_modules/.bin/brain")]);
  expect(currentModuleGeneration(f.brain)).toMatchObject({ generation: first.generation, lockHash: moduleLockHash(fs.readFileSync(join(f.brain, "bun.lock"))), trigger: "scheduled maintain" });
  const calls = f.run.mock.calls.length;
  const second = await maintainModuleStore(f.brain, f.view, f.command, "manual maintain");
  expect(second.result).toBe("unchanged"); expect(f.run.mock.calls.length - calls, "UNCHANGED_LOCK_ONLY_CHECKS_TRACKING").toBe(1);
  fs.writeFileSync(join(f.brain, "bun.lock"), "Odysseus lock 2");
  const next = await maintainModuleStore(f.brain, f.view, f.command, "manual maintain");
  expect(next.result).toBe("activated"); expect(next.generation).not.toBe(first.generation);
});
for (const failure of ["tracked", "install", "validation"] as const) test(`${failure} failure preserves fallback or previous publication and records its cause`, async () => {
  const f = fixture(); f.fail(failure);
  const first = await maintainModuleStore(f.brain, f.view, f.command, "scheduled maintain");
  expect(first, "FAILED_FIRST_INSTALL_KEEPS_FALLBACK").toMatchObject({ result: "failed", detail: expect.any(String) });
  expect(currentModuleGeneration(f.brain)).toBeUndefined();
  f.fail(undefined); const installed = await maintainModuleStore(f.brain, f.view, f.command, "scheduled maintain");
  expect(installed.result).toBe("activated");
  fs.writeFileSync(join(f.brain, "bun.lock"), "Odysseus changed lock"); f.fail(failure);
  const next = await maintainModuleStore(f.brain, f.view, f.command, "scheduled maintain");
  expect(next.result, "FAILED_UPGRADE_RETURNS_NAMED_RESULT").toBe("failed");
  expect(currentModuleGeneration(f.brain)?.generation, "FAILED_UPGRADE_RETAINS_PREVIOUS").toBe(installed.generation);
});

test("only a maintenance invocation can activate the dependency installer", () => {
  expect(moduleMaintenanceRequested(["brain", "maintain"])).toBe(true);
  expect(moduleMaintenanceRequested(["/usr/bin/bun", "scripts/brain-cli.ts", "maintain"])).toBe(true);
  expect(moduleMaintenanceRequested(["/usr/bin/bun", "run", "brain", "maintain"])).toBe(true);
  expect(moduleMaintenanceRequested(["brain", "search", "maintain"]), "QUERY_TEXT_DOES_NOT_TRIGGER_INSTALL").toBe(false);
  expect(moduleMaintenanceRequested(["brain", "module", "maintain"])).toBe(false);
});
