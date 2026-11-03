import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommands, verificationCommands, type Command } from "../scripts/ci-runner";
import { planChecks } from "../scripts/ci-plan";
import { positivePid, readPositivePid } from "./helpers/atomic-file";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ci-runner-")); dirs.push(dir); return dir; }

test("the runner executes independent children concurrently", async () => {
  const dir = fixture();
  const script = join(dir, "pair.ts");
  writeFileSync(script, `import { existsSync, watch, writeFileSync } from "node:fs";
    const [mine, other] = process.argv.slice(2);
    const watcher = watch(".", () => { if (existsSync(other!)) finish(); });
    const timer = setTimeout(() => { watcher.close(); process.exit(7); }, 1500);
    function finish() { clearTimeout(timer); watcher.close(); }
    writeFileSync(mine!, "started");
    if (existsSync(other!)) finish();
  `);
  await expect(runCommands([
    { name: "first", argv: [process.execPath, script, "first", "second"] },
    { name: "second", argv: [process.execPath, script, "second", "first"] },
  ], dir)).resolves.toBeUndefined();
  expect(existsSync(join(dir, "first"))).toBe(true); expect(existsSync(join(dir, "second"))).toBe(true);
});

test("a failed check stops its running sibling and remains a failure", async () => {
  const dir = fixture(); const alive = join(dir, "alive.ts");
  const marker = join(dir, "stopped"); const fail = join(dir, "fail.ts");
  writeFileSync(alive, `import { writeFileSync } from "node:fs";
    const timer = setInterval(() => {}, 60000);
    process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "stopped"); clearInterval(timer); });
    writeFileSync("ready", "ready");
  `);
  writeFileSync(fail, `import { existsSync, watch } from "node:fs";
    const watcher = watch(".", () => { if (existsSync("ready")) process.exit(3); });
    if (existsSync("ready")) process.exit(3);
  `);
  await expect(runCommands([
    { name: "running", argv: [process.execPath, alive] },
    { name: "refused", argv: [process.execPath, fail] },
    { name: "queued", argv: [process.execPath, "-e", 'await Bun.write("incorrectly-started", "queued")'] },
  ], dir)).rejects.toThrow("refused failed (3)");
  expect(existsSync(marker), "a failing sibling was stopped before the runner returned").toBe(true);
  expect(existsSync(join(dir, "incorrectly-started")), "a failed batch must not start queued work").toBe(false);
});

test("empty selections do not invoke bun test with its full-suite defaults", () => {
  const plan = planChecks([], []);
  expect(plan.tests).toEqual([]);
  expect(verificationCommands(plan, "/fixture")).toEqual([]);
});

test("docs-only selections execute their explicit file-reading guards", () => {
  const root = join(import.meta.dir, "..");
  const commands = verificationCommands(planChecks(["docs/supported-inputs.md"], []), root);
  expect(commands).toHaveLength(2);
  for (const command of commands) expect(command.argv.slice(1, 3)).toEqual(["run", "test"]);
  expect(commands.flatMap(command => command.argv.slice(3)).sort()).toEqual([
    "tests/decision-citations.test.ts", "tests/docs-paths.test.ts", "tests/public-docs.test.ts",
  ].map(file => join(root, file)));
});

test("selected tests retain the root command and are explicit absolute files", () => {
  const plan = planChecks(["tsconfig.json"], []);
  plan.local.fullTests = false; // This run selects cheap invariants, not complete hosted discovery.
  const root = join(import.meta.dir, "..");
  const commands = verificationCommands(plan, root);
  expect(commands).toHaveLength(3);
  expect(commands[1]!.argv.slice(1, 3)).toEqual(["run", "test"]);
  const selected = commands.slice(1).flatMap(command => command.argv.slice(3));
  expect(selected).toContain(join(root, "tests/release-manifest.test.ts"));
  expect(new Set(selected).size).toBe(plan.tests.length);
  expect(selected.sort()).toEqual(plan.tests.map(file => join(root, file)).sort());
});

test("a renamed or deleted curated test fails instead of silently dropping its guarantee", () => {
  const plan = planChecks(["README.md"], []); plan.tests = ["tests/no-longer-present.test.ts"];
  expect(() => verificationCommands(plan, fixture())).toThrow("Selected CI test is missing");
});

test("a single child failure cannot be reported as success", async () => {
  await expect(runCommands([{ name: "broken", argv: [process.execPath, "-e", "process.exit(3)"] }], fixture()))
    .rejects.toThrow("broken failed (3)");
});


test("complete hosted unit discovery avoids repeating its curated subset", () => {
  const plan = planChecks(["tsconfig.json"], []);
  expect(plan.tests.length).toBeGreaterThan(0);
  const commands = verificationCommands(plan, join(import.meta.dir, ".."));
  expect(commands.map(command => command.name)).toEqual(["strict typecheck"]);
});


test("intermediate feedback executes the affected fast subset even when final unit proof will be required", () => {
  const plan = planChecks(["tsconfig.json"], []);
  plan.cadence = "feedback";
  const root = join(import.meta.dir, "..");
  const commands = verificationCommands(plan, root);
  expect(commands[0]!.name).toBe("strict typecheck");
  expect(commands.slice(1).flatMap(command => command.argv.slice(3)).sort()).toEqual(plan.tests.map(file => join(root, file)).sort());
});


test("verification adds compiler diagnostics while preserving strict invocation and heap", () => {
  const command = verificationCommands(planChecks(["tsconfig.json"], []), join(import.meta.dir, ".."))[0]!;
  expect(command?.argv).toEqual([process.execPath, "run", "typecheck", "--extendedDiagnostics"]);
  expect(command.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096" });
  expect(command.compilerRuntime).toBe(true);
});


function recordedRunner(dir: string, commands: Command[]) {
  const script = join(dir, "coordinator.ts");
  writeFileSync(script, `import { runCommands } from ${JSON.stringify(join(import.meta.dir, "../scripts/ci-runner.ts"))};
    try { await runCommands(${JSON.stringify(commands)}, ${JSON.stringify(dir)}, 2, 100); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }`);
  return Bun.spawn([process.execPath, script], { cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, CI_COMMAND_RECEIPTS: join(dir, "receipts.jsonl") } });
}
function receipts(dir: string): { at: string; event: string; id: string; name: string; elapsedMs?: number; exitCode?: number; signal?: string | null }[] {
  return readFileSync(join(dir, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
async function waitForFile(path: string) {
  const until = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < until) await Bun.sleep(10);
  expect(existsSync(path), `child readiness marker ${path}`).toBe(true);
}

test("real command receipts attribute success, nonzero exit and signal without changing errors", async () => {
  for (const [source, exitCode, signal, error] of [
    ["process.exit(0)", 0, null, ""], ["process.exit(3)", 3, null, "probe failed (3)"],
    ['process.kill(process.pid, "SIGTERM")', 143, "SIGTERM", "probe failed (SIGTERM)"],
  ] as const) {
    const dir = fixture();
    const child = recordedRunner(dir, [{ name: "probe", argv: [process.execPath, "-e", source] }]);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(error ? 1 : 0);
    expect(stderr.trim()).toBe(error);
    const [start, end] = receipts(dir);
    expect(start!.event).toBe("start"); expect(end!.event).toBe("finish");
    expect(end!.id).toBe(start!.id); expect(end!.name).toBe("probe");
    expect(Date.parse(end!.at)).toBeGreaterThanOrEqual(Date.parse(start!.at));
    expect(end!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(end!.exitCode).toBe(exitCode); expect(end!.signal).toBe(signal);
  }
});

test("SIGTERM cleans only owned children and never emits a successful finish receipt", async () => {
  const dir = fixture();
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60000)"], { detached: true, stdout: "ignore", stderr: "ignore" });
  const child = recordedRunner(dir, [{ name: "owned", argv: [process.execPath, "-e", `
    import { writeFileSync } from "node:fs";
    const timer = setInterval(() => {}, 60000);
    process.on("SIGTERM", () => { writeFileSync("stopped", "yes"); clearInterval(timer); });
    writeFileSync("ready", "yes");`] }]);
  try {
    await waitForFile(join(dir, "ready")); child.kill("SIGTERM");
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("Checks interrupted");
    expect(existsSync(join(dir, "stopped"))).toBe(true);
    expect(unrelated.exitCode).toBeNull();
    expect(receipts(dir).map(r => r.event)).toEqual(["start", "interrupted"]);
  } finally { child.kill("SIGKILL"); unrelated.kill("SIGKILL"); await unrelated.exited; }
});

test("hard-killed coordinator leaves missing end receipt rather than invented completion", async () => {
  const dir = fixture();
  const child = recordedRunner(dir, [{ name: "unfinished", argv: [process.execPath, "-e", `
    const fs = require("node:fs"); fs.writeFileSync("pid.tmp", String(process.pid)); fs.renameSync("pid.tmp", "pid"); setInterval(() => {}, 60000);`] }]);
  try {
    await waitForFile(join(dir, "pid")); readPositivePid(join(dir, "pid"), "OWNED_COMMAND_PID_PUBLISHED"); child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(receipts(dir).map(r => r.event)).toEqual(["start"]);
  } finally {
    child.kill("SIGKILL");
    // The command publishes its PID atomically. Even so, never signal group 0:
    // process.kill(-0) is this test's own process group.
    const owned = existsSync(join(dir, "pid")) ? positivePid(readFileSync(join(dir, "pid"), "utf8")) : undefined;
    if (owned !== undefined) { try { process.kill(-owned, "SIGKILL"); } catch {} }
    await child.exited;
  }
});

test("Bun forwards extendedDiagnostics to the unchanged strict script with unchanged NODE_OPTIONS", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "./compiler --noEmit" } }));
  writeFileSync(join(dir, "compiler"), `#!/usr/bin/env node
    require("node:fs").writeFileSync("compiler.json", JSON.stringify({ argv: process.argv.slice(2), options: process.env.NODE_OPTIONS,
      executable: process.execPath, version: process.version }));`);
  chmodSync(join(dir, "compiler"), 0o755);
  const command = verificationCommands({ ...planChecks([], []), typecheck: true }, dir)[0]!;
  await runCommands([command], dir);
  const result = JSON.parse(readFileSync(join(dir, "compiler.json"), "utf8"));
  expect(result.argv).toEqual(["--noEmit", "--extendedDiagnostics"]);
  expect(result.options).toBe("--max-old-space-size=4096");
  expect(result.executable).toBeTruthy(); expect(result.version).toMatch(/^v[0-9]+\./);
});


test("receipt ownership does not leak into nested coordinator consumers", async () => {
  const dir = fixture();
  const child = recordedRunner(dir, [{ name: "outer", argv: [process.execPath, "-e", `
    import { runCommands } from ${JSON.stringify(join(import.meta.dir, "../scripts/ci-runner.ts"))};
    if (process.env.CI_COMMAND_RECEIPTS) process.exit(9);
    try { await runCommands([{ name: "expected negative control", argv: [process.execPath, "-e", "process.exit(3)"] }], process.cwd()); }
    catch { /* The nested negative control is expected, not failed outer proof. */ }`] }]);
  expect(await child.exited).toBe(0);
  expect(receipts(dir).map(r => [r.event, r.name])).toEqual([["start", "outer"], ["finish", "outer"]]);
});


test("unavailable receipt storage preserves the original command failure", async () => {
  const dir = fixture(); mkdirSync(join(dir, "receipts.jsonl"));
  const child = recordedRunner(dir, [{ name: "refused", argv: [process.execPath, "-e", "process.exit(3)"] }]);
  expect(await child.exited).toBe(1);
  const error = await new Response(child.stderr).text();
  expect(error).toContain("Command receipt file unavailable; completion evidence is incomplete");
  expect(error).toContain("refused failed (3)");
});

test("a sibling stopped by failure cannot emit successful completion after handling SIGTERM", async () => {
  const dir = fixture();
  const child = recordedRunner(dir, [
    { name: "running", argv: [process.execPath, "-e", `
      import { writeFileSync } from "node:fs";
      const timer = setInterval(() => {}, 60000);
      process.on("SIGTERM", () => { clearInterval(timer); });
      writeFileSync("ready", "yes");`] },
    { name: "refused", argv: [process.execPath, "-e", `
      import { existsSync, watch } from "node:fs";
      watch(".", () => { if (existsSync("ready")) process.exit(3); });
      if (existsSync("ready")) process.exit(3);`] },
  ]);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("refused failed (3)");
  const running = receipts(dir).filter(r => r.name === "running");
  expect(running.map(r => r.event)).toEqual(["start", "interrupted"]);
  expect(running[1]!.exitCode).toBe(0);
});


test("typecheck runtime diagnostic uses the compiler Node PATH and heap environment", async () => {
  for (const code of [0, 3]) {
    const dir = fixture();
    const lookup = Bun.spawnSync(["node", "-p", "process.execPath"], { stdout: "pipe", stderr: "pipe" });
    expect(lookup.exitCode).toBe(0);
    const realNode = new TextDecoder().decode(lookup.stdout).trim();
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.bin/node"), `#!${realNode}
      require("node:fs").appendFileSync("node-options.jsonl", JSON.stringify(process.env.NODE_OPTIONS ?? null) + "\\n");
      process.argv.splice(1, 1); process.argv[1] = require("node:path").resolve(process.argv[1]); require(process.argv[1]);`);
    chmodSync(join(dir, "node_modules/.bin/node"), 0o755);
    mkdirSync(join(dir, "node_modules/typescript"), { recursive: true });
    writeFileSync(join(dir, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "0.0.0" }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "./compiler --noEmit" } }));
    writeFileSync(join(dir, "compiler"), `#!/usr/bin/env node
      const path = require("node:path"), v8 = require("node:v8");
      require("node:fs").writeFileSync("actual.json", JSON.stringify({ executable: path.basename(process.execPath), version: process.version,
        heapLimitBytes: v8.getHeapStatistics().heap_size_limit, options: process.env.NODE_OPTIONS, argv: process.argv.slice(2) }));
      process.exit(${code});`);
    chmodSync(join(dir, "compiler"), 0o755);
    const command = verificationCommands({ ...planChecks([], []), typecheck: true }, dir)[0]!;
    const child = recordedRunner(dir, [command]);
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(code ? 1 : 0);
    if (code) expect(stderr.trim()).toEndWith("strict typecheck failed (3)");
    else expect(stderr).not.toContain("strict typecheck failed");
    const line = stdout.split("\n").find(line => line.startsWith("BRAIN_COMPILER_RUNTIME {"));
    expect(line, "ACTUAL_COMPILER_NODE_RUNTIME_RECEIPT").toBeDefined();
    const runtime = JSON.parse(line!.slice("BRAIN_COMPILER_RUNTIME ".length));
    const actual = JSON.parse(readFileSync(join(dir, "actual.json"), "utf8"));
    expect(runtime.runtime, "ACTUAL_NODE_NOT_BUN_COMPATIBILITY").toBe("node");
    expect(runtime.executable).toBe(actual.executable); expect(runtime.version).toBe(actual.version);
    expect(runtime.heapLimitBytes, "COMPILER_ENV_EFFECTIVE_HEAP").toBe(actual.heapLimitBytes);
    expect(runtime.typescript).toBe("0.0.0");
    expect(runtime.capacity.scope).toBe("OS-visible memory; cgroup limit may be lower");
    expect(runtime.capacity.totalBytes).toBeGreaterThan(0);
    expect(actual.options).toBe("--max-old-space-size=4096");
    expect(readFileSync(join(dir, "node-options.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
      "COMPILER_NODE_OPTIONS_FORWARDING").toEqual(["--max-old-space-size=4096", "--max-old-space-size=4096"]);
    expect(actual.argv).toEqual(["--noEmit", "--extendedDiagnostics"]);
    expect(runtime).not.toHaveProperty("env");
    expect(runtime.executable).not.toContain("/");
  }
});

test("unavailable compiler runtime probe still runs compiler and preserves its failure", async () => {
  const dir = fixture(); mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/.bin/node"), "#!/bin/sh\nexit 7\n"); chmodSync(join(dir, "node_modules/.bin/node"), 0o755);
  writeFileSync(join(dir, "compiler.ts"), 'await Bun.write("compiler-ran", "yes"); process.exit(3);');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: `${JSON.stringify(process.execPath)} compiler.ts` } }));
  const command = verificationCommands({ ...planChecks([], []), typecheck: true }, dir)[0]!;
  const child = recordedRunner(dir, [command]);
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(1); expect(stderr.trim()).toEndWith("strict typecheck failed (3)");
  expect(stdout, "PROBE_FAILURE_IS_DIAGNOSTIC_ONLY").toContain("BRAIN_COMPILER_RUNTIME unavailable");
  expect(existsSync(join(dir, "compiler-ran"))).toBe(true);
});
