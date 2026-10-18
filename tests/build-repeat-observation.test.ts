import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { observedBuildContext, observedBuildOutputs, observedInventory } from "../scripts/build-repeat-observation";
import { buildReceipt } from "../scripts/build-receipt";

const repo = resolve(import.meta.dir, "..");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-build-observation-"));
  const write = (name: string, value: string) => {
    mkdirSync(resolve(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), value);
  };
  write("package.json", '{"name":"odysseus-build-observation","type":"module"}');
  write("bun.lock", "Odysseus keeps a fixed dependency inventory.\n");
  write("tsconfig.json", "{}"); write(".gitignore", "node_modules\ntmp\ndist\n");
  for (const file of ["build.ts", "build-receipt.ts", "build-repeat-observation.ts", "bin-modes.ts", "publishable-packages.ts", "workspace-lease.mjs"]) {
    write(`scripts/${file}`, ""); copyFileSync(join(repo, "scripts", file), join(root, "scripts", file));
  }
  write("packages/raft/package.json", '{"name":"@fixture/raft","version":"1.0.0"}');
  write("packages/raft/tsconfig.build.json", "{}");
  write("packages/raft/src/index.ts", "export const cargo = 1;\n");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  };
  git("init", "--template="); git("add", ".");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.com", "commit", "-m", "Record the raft fixture");
  return { root, write, git };
}

test("output identity observes actual path, mode and bytes and refuses aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-output-observation-"));
  try {
    mkdirSync(join(root, "packages/raft/dist"), { recursive: true });
    const file = join(root, "packages/raft/dist/index.js"); writeFileSync(file, "export const cargo = 1;\n"); chmodSync(file, 0o644);
    const original = observedBuildOutputs(root, ["raft"]);
    expect(original.state).toBe("known"); expect(observedBuildOutputs(root, ["raft"])).toEqual(original);
    chmodSync(file, 0o755);
    expect(observedBuildOutputs(root, ["raft"]), "DIST_MODE_CHANGE_INVALIDATES_OBSERVED_EQUALITY").not.toEqual(original);
    const executable = observedBuildOutputs(root, ["raft"]); chmodSync(file, 0o4755);
    expect(observedBuildOutputs(root, ["raft"]), "DIST_SPECIAL_MODE_BITS_ARE_OBSERVED").not.toEqual(executable);
    chmodSync(file, 0o644); expect(observedBuildOutputs(root, ["raft"])).toEqual(original);
    writeFileSync(file, "export const cargo = 2;\n");
    expect(observedBuildOutputs(root, ["raft"]), "DIST_CONTENT_CHANGE_INVALIDATES_OBSERVED_EQUALITY").not.toEqual(original);
    writeFileSync(file, "export const cargo = 1;\n"); expect(observedBuildOutputs(root, ["raft"])).toEqual(original);
    rmSync(file); symlinkSync("../outside.js", file);
    expect(observedBuildOutputs(root, ["raft"])).toEqual({ state: "unknown" });
    expect(observedBuildOutputs(root, ["missing"])).toEqual({ state: "unknown" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fixed workload context observes real source changes without executing Git hooks or inferring cleanliness", () => {
  const { root, write, git } = fixture();
  try {
    write("observer-hook.sh", '#!/bin/sh\ntouch "git-observer-hook-ran"\n'); chmodSync(join(root, "observer-hook.sh"), 0o755);
    git("config", "core.fsmonitor", join(root, "observer-hook.sh"));
    git("config", "filter.observer.clean", join(root, "observer-hook.sh"));
    write(".gitattributes", "*.ts filter=observer\n");
    const original = observedBuildContext(root, ["raft"]);
    expect(original.state, "REAL_GIT_SOURCE_AND_COMPILER_ENTRY_CONTEXT_AVAILABLE").toBe("known");
    if (original.state !== "known") throw Error("Expected the owned fixture context");
    expect(original.git.cleanWorktree).toBe("unknown");
    expect(observedBuildContext(root, ["raft"])).toEqual(original);
    write("packages/raft/src/index.ts", "export const cargo = 2;\n");
    expect(observedBuildContext(root, ["raft"]), "SOURCE_CHANGE_INVALIDATES_FIXED_WORKLOAD_CONTEXT").not.toEqual(original);
    write("packages/raft/src/index.ts", "export const cargo = 1;\n"); expect(observedBuildContext(root, ["raft"])).toEqual(original);
    expect(existsSync(join(root, "git-observer-hook-ran")), "GIT_OBSERVER_EXECUTES_NO_FILTER_OR_FSMONITOR").toBe(false);
    const config = readFileSync(join(root, "tsconfig.json")); rmSync(join(root, "tsconfig.json"));
    expect(observedBuildContext(root, ["raft"])).toEqual({ state: "unknown" });
    writeFileSync(join(root, "tsconfig.json"), config); expect(observedBuildContext(root, ["raft"])).toEqual(original);
    rmSync(join(root, "packages/raft/src/index.ts")); symlinkSync("../../../../tsconfig.json", join(root, "packages/raft/src/index.ts"));
    expect(observedBuildContext(root, ["raft"])).toEqual({ state: "unknown" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing or outside observations never manufacture a known identity", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-unknown-observation-"));
  try {
    expect(observedBuildContext(root, ["raft"])).toEqual({ state: "unknown" });
    expect(observedInventory(root, ["../outside"])).toEqual({ state: "unknown" });
    expect(observedInventory(root, ["missing"])).toEqual({ state: "unknown" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("oversized real files and directories remain unknown within the fixed observation budget", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-bounded-observation-"));
  try {
    const file = join(root, "cargo"); writeFileSync(file, ""); truncateSync(file, 32 * 1024 * 1024 + 1);
    expect(observedInventory(root, ["cargo"]), "OVERSIZED_FILE_OBSERVATION_UNKNOWN").toEqual({ state: "unknown" });
    const directory = join(root, "fleet"); mkdirSync(directory);
    for (let index = 0; index < 32768; index++) writeFileSync(join(directory, String(index)), "");
    expect(observedInventory(root, ["fleet"]), "OVERSIZED_DIRECTORY_OBSERVATION_UNKNOWN").toEqual({ state: "unknown" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a real regular-file to FIFO race cannot block the observer", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-fifo-observation-"));
  try {
    const cargo = join(root, "cargo"), script = join(root, "observe.ts"); writeFileSync(cargo, "cargo");
    writeFileSync(script, `import {mock} from "bun:test";
import * as fs from "node:fs";
const realOpen=fs.openSync,realRead=fs.readSync;let created=false,descriptor=-1,readFifo=false;
mock.module("node:fs",()=>({...fs,openSync(path,...args){
  if(path===${JSON.stringify(cargo)}){fs.rmSync(path);const child=Bun.spawnSync(["mkfifo",path]);
    if(child.exitCode!==0)throw Error("Owned FIFO creation failed");created=fs.lstatSync(path).isFIFO();}
  const opened=realOpen(path,...args);if(path===${JSON.stringify(cargo)})descriptor=opened;return opened;
},readSync(fd,...args){if(fd===descriptor)readFifo=true;return realRead(fd,...args);}}));
const {observedInventory}=await import(${JSON.stringify(join(repo, "scripts/build-repeat-observation.ts"))});
const result=observedInventory(${JSON.stringify(root)},["cargo"]);
if(!created||readFifo||result.state!=="unknown")throw Error("FIFO_RACE_REMAINS_UNKNOWN_WITHOUT_READING_OR_BLOCKING");
console.log(JSON.stringify({fifo:created,readFifo,...result}));\n`);
    const child = Bun.spawn([process.execPath, script], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      timeout: 2000, killSignal: "SIGKILL" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `FIFO_RACE_OBSERVER_FINISHES_WITHOUT_A_WRITER\n${stderr}`).toBe(0);
    expect(stdout).toContain('"fifo":true,"readFifo":false,"state":"unknown"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("partial context survives before work and missing observations preserve a successful builder receipt", () => {
  const { root } = fixture();
  try {
    const receipt = buildReceipt(root, { jobs: 1, subset: true, packages: ["raft"] });
    const path = join(root, "tmp", readdirSync(join(root, "tmp")).find(name => name.endsWith("-probe.json"))!);
    const partial = JSON.parse(readFileSync(path, "utf8"));
    expect(partial.state).toBe("running"); expect(partial.repeat.state).toBe("unknown");
    expect(partial.repeat.before.state).toBe("known");
    rmSync(join(root, "tsconfig.json"));
    receipt.finish(0);
    const complete = JSON.parse(readFileSync(path, "utf8"));
    expect(complete.success, "UNKNOWN_OBSERVATION_PRESERVES_SUCCESSFUL_BUILDER_EXIT").toBe(true);
    expect(complete.code).toBe(0); expect(complete.state).toBe("complete");
    expect(complete.repeat.state, "UNKNOWN_CONTEXT_CANNOT_QUALIFY_REPETITION").toBe("unknown");
    expect(complete.repeat.after).toEqual({ state: "unknown" }); expect(complete.repeat.output).toEqual({ state: "unknown" });
    expect(complete.repeat.executionMs).toBeGreaterThanOrEqual(0);
    expect(complete.elapsedMs).toBeGreaterThanOrEqual(complete.repeat.executionMs);
    expect(JSON.stringify(complete)).not.toContain(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
