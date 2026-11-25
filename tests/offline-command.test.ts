import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { offlineCommand } from "../scripts/offline-command";
import { isDockerTest } from "../scripts/docker-test-files";

test("offline command setup refuses before the payload and records its cause", () => {
  const result = Bun.spawnSync(offlineCommand(["/bin/sh", "-c", "echo PAYLOAD_STARTED"]), {
    env: { PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(125);
  expect(result.stderr.toString()).toContain("OFFLINE_SETUP_REFUSAL");
  expect(result.stderr.toString()).toContain("unshare executable unavailable");
  expect(result.stdout.toString()).not.toContain("PAYLOAD_STARTED");
});

test("Docker driver selection names only the two real container test files", () => {
  expect(isDockerTest("tests/workspace-lease.test.ts")).toBe(true);
  expect(isDockerTest(join(import.meta.dir, "browser-determinism-container.test.ts"))).toBe(true);
  expect(isDockerTest("tests/offline-command.test.ts")).toBe(false);
});

test("mixed test selections keep each file in one command with the original flags", async () => {
  const { testCommandBatches } = await import("../scripts/test");
  const batches = await testCommandBatches(["--timeout", "30000", "tests/offline-command.test.ts", "tests/workspace-lease.test.ts"], join(import.meta.dir, ".."));
  expect(batches.map(batch => batch.docker)).toEqual([false, true]);
  expect(batches.every(batch => batch.argv.slice(0, 2).join(" ") === "--timeout 30000")).toBe(true);
  expect(batches.flatMap(batch => batch.argv.filter(arg => arg.endsWith(".test.ts")))).toHaveLength(2);
});

test("host Docker driver environments omit inherited provider credentials", async () => {
  const { cleanTestEnvironment } = await import("../scripts/offline-command");
  const inherited = { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "odysseus-fixture-key", OPENAI_API_KEY: "odysseus-fixture-key", CLAUDE_CODE_OAUTH_TOKEN: "odysseus-fixture-token", ANTHROPIC_CUSTOM_HEADERS: "odysseus-fixture-header", AWS_BEARER_TOKEN_BEDROCK: "odysseus-fixture-token", AWS_PROFILE: "odysseus", GOOGLE_APPLICATION_CREDENTIALS: "/fixture", VERTEX_PROJECT: "ithaca", OPENAI_ORG_ID: "ithaca" };
  const env = cleanTestEnvironment(inherited);
  expect(env).toEqual({ PATH: "/usr/bin:/bin" });
  const python = Bun.spawnSync(["/usr/bin/python3", "-B", "-I", "-S", "-c",
    "import importlib.util,json,sys; spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps(module.clean_env(json.loads(sys.argv[2]))))",
    join(import.meta.dir, "../scripts/offline-command.py"), JSON.stringify(inherited)], { stdout: "pipe", stderr: "pipe" });
  expect(python.exitCode, python.stderr.toString()).toBe(0);
  expect(JSON.parse(python.stdout.toString()), "PYTHON_PROVIDER_PREFIXES_MUST_BE_SCRUBBED").toEqual(env);
});


test("guarded Bun children do not autoload provider credentials from a fixture dotenv", () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-child-env-"));
  try {
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "odysseus-child-env", private: true }));
    writeFileSync(join(scratch, ".env"), "ANTHROPIC_API_KEY=odysseus-fixture-key\n");
    const child = Bun.spawnSync([process.execPath, "-e", "if(process.env.ANTHROPIC_API_KEY)throw Error('BUN_CHILD_DOTENV_MUST_NOT_LOAD_CREDENTIALS')"], {
      cwd: scratch, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});


test("the launcher guards the HOME that its test command actually receives", async () => {
  const { invocationFixture } = await import("./helpers/test-invocation-fixture");
  const { root, write } = invocationFixture();
  try {
    // This deliberate write bypasses the working-home preload, exactly as a
    // native child could. The runner must observe its own invoking sentinel.
    write("scripts/test-network-preload.ts", "");
    write("write-home.test.ts", `import {test} from "bun:test"; import {writeFileSync} from "node:fs"; import {join} from "node:path";
      test("deliberate invoking storage write",()=>writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!,"sentinel"),"changed"));`);
    const child = Bun.spawn([process.execPath, "--no-env-file", join(root, "scripts/test.ts"), "--timeout", "30000", "write-home.test.ts"], {
      cwd: root, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout + stderr).toContain("1 pass");
    expect(code, "INVOKING_HOME_WRITE_MUST_BE_OBSERVED").not.toBe(0);
    expect(stderr).toContain("TEST_WROTE_INVOKING_CLAUDE_HOME");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mixed batches use distinct JUnit paths for both outfile flag forms", async () => {
  const { testCommandBatches } = await import("../scripts/test");
  for (const flag of [["--reporter-outfile", "tmp/results.xml"], ["--reporter-outfile=tmp/results.xml"]]) {
    const batches = await testCommandBatches(["--reporter=junit", ...flag, "tests/offline-command.test.ts", "tests/workspace-lease.test.ts"], join(import.meta.dir, ".."));
    expect(batches[0]!.argv.join(" "), "ORDINARY_JUNIT_MUST_BE_RETAINED").toContain("tmp/results.xml.ordinary.xml");
    expect(batches[1]!.argv.join(" "), "DOCKER_JUNIT_MUST_BE_DISTINCT").toContain("tmp/results.xml.docker.xml");
  }
});


test("mixed command reports retain every executed file in the requested aggregate", async () => {
  const { testCommandBatches, mergeBatchReports } = await import("../scripts/test");
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-batch-reports-"));
  try {
    mkdirSync(join(scratch, "tests"));
    const files = ["tests/ordinary.test.ts", "tests/workspace-lease.test.ts"];
    for (const [index, file] of files.entries()) writeFileSync(join(scratch, file), `import {test,expect} from "bun:test";test("receipt ${index}",()=>expect(true).toBe(true));`);
    const argv = ["--reporter=junit", "--reporter-outfile=" + join(scratch, "report.xml"), "--timings=" + join(scratch, "timings.json"), "--update-timings", ...files];
    const batches = await testCommandBatches(argv, scratch);
    for (const batch of batches) {
      const child = Bun.spawnSync([process.execPath, "test", "--no-env-file", "--timeout", "30000", ...batch.argv], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
    }
    await mergeBatchReports(argv, batches);
    const xml = readFileSync(join(scratch, "report.xml"), "utf8");
    expect(xml, "MIXED_JUNIT_RETAINS_ORDINARY_CASE").toContain('name="receipt 0"');
    expect(xml, "MIXED_JUNIT_RETAINS_DOCKER_CASE").toContain('name="receipt 1"');
    expect(xml).toContain('tests="2"');
    expect(Object.keys(JSON.parse(readFileSync(join(scratch, "timings.json"), "utf8")).files).sort()).toEqual(files);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
