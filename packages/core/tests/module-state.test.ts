/**
 * The per-module state area (#3380). A module command gets
 * `ctx.stateDir()`, `.brain-ui/modules/<name>/` under the brain root the CLI
 * resolved, created with its own `.gitignore`. State one run writes there is
 * what the next run reads. Inside a worker, the root is the writable data
 * root, never the frozen configuration view the worker's working directory
 * shows. A module command's write to a read-only path outside the brain fails
 * with a message that names the boundary and the state area.
 *
 * The Odysseus brain's local `beacon` module keeps a run counter, as its
 * scheduled `beacon run` job does between cron runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { MODULE_STATE_DIR, ModuleStateError, moduleStateDir, moduleStatePath } from "../src/module";

const roots: string[] = [];
afterEach(() => { while (roots.length) cleanup(roots.pop()!); });

const BEACON = `export default {
  name: "beacon",
  setup: () => ({
    commands: {
      beacon: async () => ({
        summary: "Light the watchtower beacon",
        async run(args, ctx) {
          const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
          if (args[0] === "host-write") {
            // What mkdir on a read-only host directory throws inside a worker.
            throw Object.assign(new Error("EROFS: read-only file system, mkdir '/var/lib/ithaca-beacon'"), { code: "EROFS", syscall: "mkdir", path: "/var/lib/ithaca-beacon" });
          }
          if (args[0] === "brain-write") {
            throw Object.assign(new Error("EROFS: read-only file system, open"), { code: "EROFS", syscall: "open", path: ctx.root + "/notes/watch.md" });
          }
          const file = ctx.stateDir() + "/last-run.json";
          const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { runs: 0 };
          const next = { runs: previous.runs + 1, lastCheck: "harbor-light" };
          writeFileSync(file, JSON.stringify(next));
          console.log(JSON.stringify({ previous, next, stateDir: ctx.stateDir() }));
        },
      }),
    },
    cron: [{ name: "run", schedule: "*/30 * * * *", command: "beacon run" }],
  }),
};
`;

function brainWithBeacon(): string {
  const brain = makeTempBrain();
  roots.push(brain);
  mkdirSync(join(brain, "modules/beacon"), { recursive: true });
  writeFileSync(join(brain, "modules/beacon/module.ts"), BEACON);
  const config = readFileSync(join(brain, "brain.config.ts"), "utf8");
  writeFileSync(join(brain, "brain.config.ts"), config.replace("defineConfig({", 'defineConfig({\n  modules: { "./modules/beacon": {} },'));
  return brain;
}

describe("module state area (#3380)", () => {
  test("state one run writes is what the next run reads, in a gitignored per-module directory", async () => {
    const brain = brainWithBeacon();
    const first = await runCli(brain, ["beacon", "run"]);
    expect(first.code, first.stderr).toBe(0);
    const firstOut = JSON.parse(first.stdout);
    expect(firstOut.previous, "the first run finds no state").toEqual({ runs: 0 });
    const second = await runCli(brain, ["beacon", "run"]);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).previous, "STATE_PERSISTS: the second run reads what the first wrote").toEqual({ runs: 1, lastCheck: "harbor-light" });
    expect(firstOut.stateDir).toBe(join(brain, MODULE_STATE_DIR, "beacon"));
    expect(readFileSync(join(brain, MODULE_STATE_DIR, ".gitignore"), "utf8")).toContain("*");
    // The area's own .gitignore keeps it out of history, whatever the root .gitignore says.
    expect(Bun.spawnSync(["git", "init", "-q", brain]).exitCode).toBe(0);
    const ignored = Bun.spawnSync(["git", "-C", brain, "check-ignore", "-q", "--no-index", `${MODULE_STATE_DIR}/beacon/last-run.json`]);
    expect(ignored.exitCode, "STATE_GITIGNORED").toBe(0);
  });

  test("inside a worker the state area is under the writable data root, not the frozen configuration view", async () => {
    const config = brainWithBeacon();
    const data = mkdtempSync(join(config, "..", "brain-data-"));
    roots.push(data);
    cpSync(config, data, { recursive: true, filter: source => !source.endsWith("/node_modules") });
    symlinkSync(join(config, "node_modules"), join(data, "node_modules"));
    const env = { BRAIN_ROOT: data, BRAIN_WORKER_DATA_ROOT: data, BRAIN_WORKER_CONFIG_ROOT: config };
    const run = await runCli(config, ["beacon", "run"], env);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).stateDir).toBe(join(data, MODULE_STATE_DIR, "beacon"));
    expect(existsSync(join(data, MODULE_STATE_DIR, "beacon/last-run.json")), "STATE_ON_DATA_ROOT").toBe(true);
    expect(existsSync(join(config, MODULE_STATE_DIR)), "nothing written into the configuration view").toBe(false);
  });

  test("a write to a read-only host path names the boundary and the state area, not a bare EROFS", async () => {
    const brain = brainWithBeacon();
    const inWorker = await runCli(brain, ["beacon", "host-write"], { BRAIN_WORKER_DATA_ROOT: brain, BRAIN_WORKER_CONFIG_ROOT: brain });
    expect(inWorker.code).toBe(2);
    expect(inWorker.stderr, "EROFS_NAMES_BOUNDARY").toContain("host execution boundary");
    expect(inWorker.stderr).toContain("/var/lib/ithaca-beacon is read-only");
    expect(inWorker.stderr).toContain(".brain-ui/modules/beacon/");
    const onHost = await runCli(brain, ["beacon", "host-write"]);
    expect(onHost.code).toBe(2);
    expect(onHost.stderr).toContain(".brain-ui/modules/beacon/");
    expect(onHost.stderr).not.toContain("host execution boundary");
  });

  test("a read-only write inside the brain keeps core's read_only_brain refusal", async () => {
    const brain = brainWithBeacon();
    const result = await runCli(brain, ["beacon", "brain-write", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("read_only_brain");
  });

  test("the state path refuses names that are not module names and links on the way", () => {
    expect(moduleStatePath("beacon")).toBe(".brain-ui/modules/beacon");
    expect(() => moduleStatePath("../ithaca")).toThrow(ModuleStateError);
    const brain = makeTempBrain({ empty: true });
    roots.push(brain);
    const outside = mkdtempSync(join(brain, "..", "beacon-outside-"));
    roots.push(outside);
    mkdirSync(join(brain, ".brain-ui"));
    symlinkSync(outside, join(brain, ".brain-ui/modules"));
    expect(() => moduleStateDir(brain, "beacon")).toThrow(/symlink/);
    expect(existsSync(join(outside, "beacon")), "nothing created through the link").toBe(false);
  });
});
