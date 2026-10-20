import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPackages } from "../scripts/check-packages";
import { localChecks, requireLocalSandbox, requireRuntimeTools } from "../scripts/check-pr";
import { testArgv } from "../scripts/test";
import { planChecks, workspaces } from "../scripts/ci-plan";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-checks-")); dirs.push(dir);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  return dir;
}

function mountTable(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1} 0 0:1 / /mnt/fixture/binds/${i} rw - tmpfs tmpfs rw`).join("\n") + "\n";
}

test("sandbox prerequisite permits 249 ms despite a large mount table", () => {
  expect(requireLocalSandbox( () => mountTable(8000), () => 249)).toBeUndefined();
});

test("sandbox prerequisite refuses 250 ms before downstream checks", () => {
  const which = spyOn(Bun, "which").mockReturnValue("/fixture/tool");
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("bubblewrap 0.9.0\n") } as ReturnType<typeof Bun.spawnSync>);
  try {
    {
      expect(() => requireLocalSandbox( () => mountTable(20), () => 250))
        .toThrow("fastest of three 250.0 ms (requires less than 250 ms); bubblewrap 0.9.0; 20 mount entries; dominant mount-point prefix: /mnt/fixture/binds (20 entries). Use bubblewrap 0.13 or newer. Restart Docker Desktop, or on WSL2 run wsl --shutdown");
    }
    expect(which).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(["bwrap", "--version"], { timeout: 5000 });
  } finally { which.mockRestore(); spawn.mockRestore(); }
});

test("sandbox prerequisite compares the fastest of exactly three probes", () => {
  const samples = [900, 249, 300];
  const timer = () => samples.shift()!;
  expect(requireLocalSandbox( () => mountTable(8000), timer)).toBeUndefined();
  expect(samples).toEqual([]);
});

test("sandbox prerequisite timeout reports a lower bound and actionable host diagnostics", () => {
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(argv => {
    const command = Array.isArray(argv) ? argv : argv.cmd;
    return {
      exitCode: command[1] === "--version" ? 0 : 143,
      exitedDueToTimeout: command[1] !== "--version",
      stdout: new TextEncoder().encode(command[1] === "--version" ? "bubblewrap 0.9.0\n" : ""),
    } as ReturnType<typeof Bun.spawnSync>;
  });
  try {
    let message = "";
    try { requireLocalSandbox(() => mountTable(24000)); }
    catch (error) { message = (error as Error).message; }
    expect(message, "TIMED_OUT_SANDBOX_MUST_REPORT_ACTIONABLE_LOWER_BOUND")
      .toContain("probe timed out; setup elapsed at least 5000 ms (5000 ms probe budget; requires less than 250 ms)");
    expect(message).toContain("bubblewrap 0.9.0; 24000 mount entries; dominant mount-point prefix: /mnt/fixture/binds (24000 entries)");
    expect(message).toContain("Use bubblewrap 0.13 or newer. Restart Docker Desktop, or on WSL2 run wsl --shutdown");
    expect(message).not.toContain("fastest of three");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]).toEqual([["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { timeout: 5000 }]);
    expect(spawn.mock.calls[1]).toEqual([["bwrap", "--version"], { timeout: 5000 }]);
  } finally { spawn.mockRestore(); }
});

test("sandbox prerequisite does not classify nonzero, signal or spawn errors as slow timeouts", () => {
  const spawn = spyOn(Bun, "spawnSync");
  try {
    for (const result of [{ exitCode: 1 }, { exitCode: 124 }, { exitCode: 137, signalCode: "SIGKILL", exitedDueToTimeout: false }]) {
      spawn.mockReturnValue(result as ReturnType<typeof Bun.spawnSync>);
      expect(() => requireLocalSandbox(() => { throw new Error("MOUNT_DIAGNOSTICS_MUST_NOT_RUN_FOR_FAILED_SETUP"); }))
        .toThrow("sandbox setup probe failed");
    }
    const failure = new Error("Odysseus bwrap permission denied");
    spawn.mockImplementation(() => { throw failure; });
    expect(() => requireLocalSandbox()).toThrow(failure);
    expect(spawn).toHaveBeenCalledTimes(4);
  } finally { spawn.mockRestore(); }
});

test("sandbox prerequisite reports the largest parent prefix and decodes mountinfo escapes", () => {
  const table = mountTable(600).replaceAll("/mnt/fixture/binds", "/mnt/fixture/binds\\040here") +
    mountTable(400).replaceAll("/mnt/fixture/binds", "/other");
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("bubblewrap fixture") } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(() => requireLocalSandbox( () => table, () => 300))
      .toThrow("dominant mount-point prefix: /mnt/fixture/binds here (600 entries)");
  } finally { spawn.mockRestore(); }
});

test("sandbox prerequisite runs the real namespace command three times and rejects failed setup", () => {
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(requireLocalSandbox()).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenCalledWith(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { timeout: 5000 });
    spawn.mockReturnValue({ exitCode: 1 } as ReturnType<typeof Bun.spawnSync>);
    expect(() => requireLocalSandbox()).toThrow("sandbox setup probe failed");
  } finally { spawn.mockRestore(); }
});

test("focused and full local CLI refuse setup before downstream proof while plan stays inspection-only", async () => {
  const dir = fixture(), preload = join(dir, "odysseus-refused-setup.ts");
  const owner = resolve(import.meta.dir, ".."), entry = join(dir, "scripts/check-pr.ts");
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "packages/ithaca"), { recursive: true });
  mkdirSync(join(dir, "tmp"));
  // Keep the actual entry byte-identical; only static imports forward to real
  // helpers. Planning must inspect this tiny Git root, never the worker checkout.
  cpSync(join(owner, "scripts/check-pr.ts"), entry);
  expect(readFileSync(entry)).toEqual(readFileSync(join(owner, "scripts/check-pr.ts")));
  for (const helper of ["ci-plan", "ci-runner", "check-packages"]) {
    writeFileSync(join(dir, `scripts/${helper}.ts`), `export * from ${JSON.stringify(join(owner, `scripts/${helper}.ts`))};\n`);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
  writeFileSync(join(dir, "packages/ithaca/package.json"), JSON.stringify({ name: "@odysseus/ithaca" }));
  writeFileSync(join(dir, ".gitignore"), "tmp/\n");
  writeFileSync(preload, `import {appendFileSync} from "node:fs";
    import {dirname,resolve} from "node:path";
    const root=${JSON.stringify(dir)}, trace=process.env.LOCAL_CLI_TRACE;
    if(resolve(dirname(process.argv[1]),"..")!==root || process.cwd()!==root)
      throw new Error("EXPECTED_FIXTURE_ROOT_BEFORE_SCAN");
    const original=Bun.spawnSync;
    Bun.spawnSync=((argv,options)=>{
      const command=Array.isArray(argv)?argv:argv.cmd;
      const settings=Array.isArray(argv)?options:argv;
      if(command[0]==="git" && resolve(settings?.cwd??process.cwd())!==root)
        throw new Error("EXPECTED_FIXTURE_ROOT_BEFORE_SCAN");
      if(trace)appendFileSync(trace,JSON.stringify(command)+"\\n");
      if(command[0]==="bwrap")return {exitCode:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};
      if(command[0]!=="git")throw new Error("UNEXPECTED_FIXTURE_DISCOVERY_COMMAND");
      return original(argv,options);});
    Bun.spawn=()=>{throw new Error("DOWNSTREAM_PROOF_REACHED_BEFORE_SANDBOX_REFUSAL");};`);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "fixture");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"], description: "Odysseus plans the return." }));
  for (const mode of [[], ["--full"], ["--plan"]]) {
    const trace = join(dir, "tmp", `${mode[0] ?? "default"}.jsonl`), started = performance.now();
    const child = Bun.spawn([process.execPath, "--preload", preload, entry, "--base", base, ...mode],
      { cwd: dir, env: { ...process.env, LOCAL_CLI_TRACE: trace }, stdout: "pipe", stderr: "pipe" });
    const drained = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    let result: Awaited<typeof drained>;
    try { result = await drained; }
    finally { if (child.exitCode === null) child.kill(); await drained; }
    const [code, out, error] = result;
    const calls: string[][] = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    console.info(JSON.stringify({ mode: mode[0] ?? "default", code, elapsedMs: performance.now() - started, calls }));
    expect(error, "EXPECTED_FIXTURE_ROOT_BEFORE_SCAN").not.toContain("EXPECTED_FIXTURE_ROOT_BEFORE_SCAN");
    expect(error).not.toContain("UNEXPECTED_FIXTURE_DISCOVERY_COMMAND");
    if (mode[0] === "--plan") {
      expect(code, error).toBe(0); expect(out).toContain("hostedProofRequired");
      expect(calls.some(command => command[0] === "bwrap")).toBe(false);
    } else {
      expect(code, "LOCAL_CLI_MUST_REFUSE_FAILED_SANDBOX_SETUP").not.toBe(0);
      expect(error, "LOCAL_CLI_REFUSES_BEFORE_DOWNSTREAM_PROOF").toContain("sandbox setup probe failed");
      expect(error).not.toContain("DOWNSTREAM_PROOF_REACHED");
      expect(calls.filter(command => command[0] === "bwrap")).toHaveLength(1);
    }
    const plan = JSON.parse(out);
    expect(plan.changed).toEqual(["package.json"]);
    expect(plan.affected).toEqual(["ithaca"]);
    expect(plan.global).toBe(true);
    expect(plan.typecheck).toBe(true); expect(plan.pack).toBe(true);
    expect(plan.hostedProofRequired).toEqual({ fullTests: true, browser: false, layout: false, captures: false, runtime: true, endurance: false });
    expect(plan.packedConsumerChecks).toBe(mode[0] === "--full");
    expect(plan.commands).toContain("all lint and leakage gates");
  }
});

test("container-backed hosted categories do not require host sandbox setup", () => {
  const which = spyOn(Bun, "which").mockImplementation(name => name === "docker" || name === "flock" ? `/fixture/${name}` : null);
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("HOST_SANDBOX_MUST_NOT_RUN_FOR_CONTAINER_PROOF"); });
  try {
    for (const category of ["browser", "layout", "captures", "endurance"] as const) {
      const plan = planChecks([], []);
      plan.local = { ...plan.local, fullTests: false, [category]: true };
      expect(() => requireRuntimeTools(plan), "HOSTED_CONTAINER_CATEGORY_HAS_NO_HOST_SANDBOX_PREREQUISITE").not.toThrow();
    }
    expect(spawn).not.toHaveBeenCalled();
  } finally { which.mockRestore(); spawn.mockRestore(); }
});

test("runtime tools reject invalid Chrome paths before launching any child", () => {
  const dir = fixture();
  const file = join(dir, "non-executable"); writeFileSync(file, "fixture"); chmodSync(file, 0o600);
  const dangling = join(dir, "dangling"); symlinkSync(join(dir, "absent-target"), dangling);
  const plan = planChecks(["package.json"], []);
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  const which = spyOn(Bun, "which").mockImplementation(name => `/fixture/${name}`);
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("Unexpected child launch"); });
  try {
    for (const path of [dir, file, join(dir, "absent"), dangling]) {
      process.env.PUPPETEER_EXECUTABLE_PATH = path;
      expect(() => requireRuntimeTools(plan)).toThrow(`Local runtime proof requires real Chrome; set PUPPETEER_EXECUTABLE_PATH (rejected path: ${path})`);
      expect(spawn).not.toHaveBeenCalled();
    }
  } finally {
    which.mockRestore(); spawn.mockRestore();
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});

test("runtime tools accept executable regular files and symlinks and retain the namespace probe", () => {
  const dir = fixture(); const file = join(dir, "chrome");
  writeFileSync(file, "fixture"); chmodSync(file, 0o700);
  const link = join(dir, "chrome-link"); symlinkSync(file, link);
  const plan = planChecks(["package.json"], []);
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  const which = spyOn(Bun, "which").mockImplementation(name => `/fixture/${name}`);
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as ReturnType<typeof Bun.spawnSync>);
  try {
    for (const path of [file, link]) {
      process.env.PUPPETEER_EXECUTABLE_PATH = path;
      expect(requireRuntimeTools(plan)).toBe(path);
    }
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"]);
  } finally {
    which.mockRestore(); spawn.mockRestore();
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});

test("local packaging executes the source job's phases in order and removes the temporary consumer", async () => {
  const dir = fixture();
  writeFileSync(join(dir, ".github/workflows/ci.yml"), `jobs:
  pack:
    steps:
      - run: mkdir -p "$RUNNER_TEMP/consumer"; echo packed > "$RUNNER_TEMP/consumer/package"
      - run: test -f "$RUNNER_TEMP/consumer/package"; echo "$RUNNER_TEMP" > scratch-path
`);
  await checkPackages(dir);
  const scratch = readFileSync(join(dir, "scratch-path"), "utf8").trim();
  expect(scratch).toContain("brainkit-pack-"); expect(existsSync(scratch)).toBe(false);
});

test("a failing packed probe cannot pass through a pipeline or execute later phases", async () => {
  const dir = fixture();
  writeFileSync(join(dir, ".github/workflows/ci.yml"), `jobs:
  pack:
    steps:
      - name: broken consumer
        run: 'false | true'
      - run: echo incorrectly-passed > passed
`);
  await expect(checkPackages(dir)).rejects.toThrow("broken consumer failed (1)");
  expect(existsSync(join(dir, "passed"))).toBe(false);
});

test("the full local plan retains default discovery, real probes and every pinned browser category", () => {
  const root = join(import.meta.dir, "..");
  const plan = planChecks(["package.json"], workspaces(root));
  const commands = localChecks(plan, true);
  const full = commands.find(command => command.name === "complete unit and integration suite")!;
  expect(full.argv.slice(1)).toEqual(["run", "test"]);
  expect(full.env?.BRAIN_REQUIRE_CHROME).toBe("1");
  const args = commands.map(command => command.argv.join(" ")).join("\n");
  expect(args).toContain("run test:browser"); expect(args).toContain("run test:layout");
  expect(args).toContain("run capture:verify"); expect(args).toContain("measure-claude-runtime.ts");
  expect(args).toContain("measure-claude-enforcement.ts");
  expect(args).toContain("--map-current-user --keep-caps --net");
  expect(args).toContain("measure-claude-delegation.ts");
  expect(args).toContain("measure-claude-capability.ts");
  expect(args).toContain("measure-claude-haiku.ts");
  expect(args).toContain("run test ./tests/measurement-isolation.test.ts");
  expect(args).toContain("--shard=1/1 packages/ui-react/tests/chat-focus-runtime.test.ts packages/ui-react/tests/external-speech-runtime.test.ts");
});


test("ordinary preflight leaves repeatable environment-heavy proof to CI", () => {
  const plan = planChecks(["package.json"], workspaces(join(import.meta.dir, "..")));
  const commands = localChecks(plan);
  expect(commands.length).toBeGreaterThan(0);
  const args = commands.map(command => command.argv.join(" ")).join("\n");
  expect(args).not.toContain("run typecheck");
  expect(commands.some(command => command.name === "complete unit and integration suite")).toBe(false);
  const tests = commands.filter(command => command.argv[1] === "run" && command.argv[2] === "test");
  expect(tests).toHaveLength(1);
  expect(tests[0]!.argv.slice(3)).toEqual(plan.tests.map(path => `./${path}`));
  expect(tests[0]!.argv.slice(3).length).toBeGreaterThan(0);
  expect(args).not.toContain("run test:browser");
  expect(args).not.toContain("run test:layout");
  expect(args).not.toContain("run capture:verify");
  expect(args).not.toContain("unshare");
});


test("default local feedback uses the exact merge-base SHA and full proof does not duplicate it", () => {
  const plan = planChecks(["packages/common/src/index.ts"], workspaces(join(import.meta.dir, "..")));
  const sha = "a".repeat(40);
  const feedback = localChecks(plan, false, sha).filter(command => command.name.startsWith("import-graph affected tests"));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]!.argv.slice(1)).toEqual(["run", "test", `--changed=${sha}`, "--pass-with-no-tests"]);
  expect(localChecks(plan, true, sha).some(command => command.name.startsWith("import-graph affected tests"))).toBe(false);
});


/** Real wrapper in an isolated git repository; no external transport can run. */
function importFixture() {
  const dir = fixture();
  const root = join(import.meta.dir, "..");
  mkdirSync(join(dir, "scripts"));
  for (const helper of ["test.ts", "runtime-test-builds.ts", "test-invocation.ts", "test-invocation-child.ts", "publishable-packages.ts", "test-shards.ts", "test-shard-costs.json", "test-network-preload.ts", "test-network-guard.ts", "test-network-child-preload.ts", "workspace-lease.mjs"]) {
    cpSync(join(root, "scripts", helper), join(dir, "scripts", helper));
  }
  mkdirSync(join(dir, "packages/core/tests"), { recursive: true });
  cpSync(join(root, "packages/core/tests/cli-harness.ts"), join(dir, "packages/core/tests/cli-harness.ts"));
  mkdirSync(join(dir, "packages/fixture/src"), { recursive: true });
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun scripts/test.ts --timeout 30000" } }));
  writeFileSync(join(dir, ".gitignore"), "tmp/\n");
  writeFileSync(join(dir, "packages/fixture/src/value.ts"), "export const value = 1;\n");
  writeFileSync(join(dir, "tests/imported.test.ts"), `import {test,expect} from "bun:test"; import {value} from "../packages/fixture/src/value"; test("IMPORTED_CASE",()=>{expect(value).toBeGreaterThan(0);console.log("RAN_"+"IMPORTED");});`);
  writeFileSync(join(dir, "tests/unrelated.test.ts"), `import {test} from "bun:test"; test("UNRELATED_CASE",()=>console.log("RAN_"+"UNRELATED"));`);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD");
  async function run() {
    const command = localChecks(planChecks([], []), false, sha).find(command => command.name.startsWith("import-graph affected tests"))!;
    // The outer test guard deliberately does not recognize this alias. The
    // copied wrapper must install its own preload, as in an ordinary shell.
    const runtime = join(dir, "probe-runtime");
    if (!existsSync(runtime)) symlinkSync(process.execPath, runtime);
    const child = Bun.spawn([runtime, ...command.argv.slice(1)], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: stdout + stderr };
  }
  return { dir, git, sha, run };
}

test("import feedback selects imported committed, staged and unstaged changes, excluding unrelated tests", async () => {
  const fixture = importFixture();
  for (const state of ["unstaged", "staged", "committed"]) {
    writeFileSync(join(fixture.dir, "packages/fixture/src/value.ts"), `export const value = ${state.length};\n`);
    if (state !== "unstaged") fixture.git("add", "packages/fixture/src/value.ts");
    if (state === "committed") fixture.git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "source change");
    const result = await fixture.run();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("RAN_IMPORTED");
    expect(result.output).not.toContain("RAN_UNRELATED");
  }
});

test("import feedback includes untracked tests and prose-only changes print an empty-selection reason", async () => {
  const fixture = importFixture();
  writeFileSync(join(fixture.dir, "README.md"), "Odysseus plans the return.\n");
  const empty = await fixture.run();
  expect(empty.code, empty.output).toBe(0);
  expect(empty.output).toContain("no test files are affected");
  expect(empty.output).not.toContain("RAN_IMPORTED");
  expect(empty.output).not.toContain("RAN_UNRELATED");
  writeFileSync(join(fixture.dir, "tests/new.test.ts"), `import {test} from "bun:test";test("new",()=>console.log("RAN_"+"NEW"));`);
  const untracked = await fixture.run();
  expect(untracked.code, untracked.output).toBe(0);
  expect(untracked.output).toContain("RAN_NEW");
  expect(untracked.output).not.toContain("RAN_UNRELATED");
});

test("import feedback retains directory roots and equals-only optional changed value", () => {
  const flag = `--changed=${"a".repeat(40)}`;
  expect(testArgv([flag, "--pass-with-no-tests"])).toEqual(["./packages", "./tests", flag, "--pass-with-no-tests"]);
  expect(testArgv(["--changed", "packages/fixture"])).toEqual(["--changed", "packages/fixture"]);
});

test("import feedback offline guard fails a caught fetch without dispatching its native sentinel", async () => {
  const fixture = importFixture();
  // A lower transport sentinel makes the negative control explicitly offline
  // even when the wrapper's preload is deliberately removed for mutation proof.
  writeFileSync(join(fixture.dir, "sentinel.ts"), `globalThis.fetch = async () => {console.log("NATIVE_"+"TRANSPORT_CALLED"); return new Response("fixture");};`);
  writeFileSync(join(fixture.dir, "bunfig.toml"), '[test]\npreload=["./sentinel.ts"]\n');
  writeFileSync(join(fixture.dir, "tests/guard.test.ts"), `import {test} from "bun:test";test("IMPORT_FEEDBACK_OFFLINE_GUARD",async()=>{await fetch("https://escape.example.invalid/probe").catch(()=>{});});`);
  const result = await fixture.run();
  expect(result.code, "IMPORT_FEEDBACK_OFFLINE_GUARD_EXIT\n" + result.output).not.toBe(0);
  expect(result.output).toContain("Offline test guard");
  expect(result.output).not.toContain("NATIVE_TRANSPORT_CALLED");
});
