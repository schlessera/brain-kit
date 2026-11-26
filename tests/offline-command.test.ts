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
  expect(isDockerTest("/tmp/other-checkout/tests/workspace-lease.test.ts"), "FOREIGN_DRIVER_IS_NOT_EXEMPT").toBe(false);
  expect(isDockerTest("tests/fixtures/tests/workspace-lease.test.ts"), "NESTED_DRIVER_IS_NOT_EXEMPT").toBe(false);
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
  const inherited = { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "odysseus-fixture-key", OPENAI_API_KEY: "odysseus-fixture-key", CLAUDE_CODE_OAUTH_TOKEN: "odysseus-fixture-token", ANTHROPIC_CUSTOM_HEADERS: "odysseus-fixture-header", AWS_BEARER_TOKEN_BEDROCK: "odysseus-fixture-token", AWS_PROFILE: "odysseus", AZURE_CLIENT_SECRET: "odysseus-fixture-secret", AZURE_TENANT_ID: "ithaca", AZURE_CLIENT_ID: "odysseus", GOOGLE_APPLICATION_CREDENTIALS: "/fixture", VERTEX_PROJECT: "ithaca", OPENAI_ORG_ID: "ithaca" };
  const env = cleanTestEnvironment(inherited);
  expect(env, "PROVIDER_CREDENTIAL_PREFIXES_MUST_BE_SCRUBBED").toEqual({ PATH: "/usr/bin:/bin" });
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
  const { invocationFixture } = await import("./helpers/test-invocation-fixture");
  const { root: scratch } = invocationFixture();
  const { testCommandBatches, mergeBatchReports } = await import(join(scratch, "scripts/test.ts")) as typeof import("../scripts/test");
  try {
    mkdirSync(join(scratch, "tests"), { recursive: true });
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


test("a pure loopback boundary still needs the browser online indicator", () => {
  const pure = Bun.spawnSync(offlineCommand(["--check"]), { stdout: "pipe", stderr: "pipe" });
  expect(pure.exitCode, "ORDINARY_BOUNDARY_IS_REUSABLE").toBe(0);
  const browser = Bun.spawnSync(offlineCommand(["--check"], true), { stdout: "pipe", stderr: "pipe" });
  expect(browser.exitCode, "BROWSER_BOUNDARY_REQUIRES_ITS_INDICATOR").toBe(1);
});


test("an absolute tests directory splits its exact Docker drivers", async () => {
  const { testCommandBatches } = await import("../scripts/test");
  const batches = await testCommandBatches([join(import.meta.dir)], join(import.meta.dir, ".."));
  expect(batches.filter(batch => batch.docker).flatMap(batch => batch.argv).sort(), "ABSOLUTE_DIRECTORY_RETAINS_DRIVER_BATCH").toEqual([
    join(import.meta.dir, "browser-determinism-container.test.ts"), join(import.meta.dir, "workspace-lease.test.ts"),
  ]);
});


test("mixed substring selections run each match once and keep ordinary files out of Docker", async () => {
  const { invocationFixture } = await import("./helpers/test-invocation-fixture");
  const { root, write } = invocationFixture();
  try {
    const { testCommandBatches } = await import(join(root, "scripts/test.ts")) as typeof import("../scripts/test");
    const files = ["tests/ordinary.test.ts", "tests/workspace-lease.test.ts", "tests/chat-focus-extra.test.ts", "packages/ui-react/tests/chat-focus-runtime.test.ts"];
    for (const file of files) write(file, `import {test} from "bun:test";test("${file}",()=>console.log("MATCHED_FILE ${file}"));`);
    const batches = await testCommandBatches(["chat-focus", files[0]!, files[1]!], root);
    expect(batches).toHaveLength(3);
    expect(batches.find(batch => batch.docker)!.argv, "DOCKER_BATCH_HAS_ONLY_ITS_EXACT_DRIVER").toEqual([join(root, files[1]!)]);
    const executed: string[] = [];
    for (const batch of batches) {
      const child = Bun.spawnSync([process.execPath, "test", "--no-env-file", "--timeout", "30000", ...batch.argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      executed.push(...[...child.stdout.toString().matchAll(/^MATCHED_FILE (.+)$/gm)].map(match => match[1]!));
    }
    expect(executed.sort(), "SUBSTRING_MATCHES_RUN_EXACTLY_ONCE").toEqual([...files].sort());
    expect((await testCommandBatches(["chat-focus-runtime"], root))[0]!.argv).toEqual(["chat-focus-runtime"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("Docker selection resolves both cwd flag forms against Bun's effective directory", async () => {
  const { testCommandBatches } = await import("../scripts/test");
  const root = join(import.meta.dir, "..");
  for (const flag of [["--cwd", "tests"], ["--cwd=tests"]]) {
    const batch = await testCommandBatches([...flag, "./workspace-lease.test.ts"], root);
    expect(batch[0]!.docker, "CWD_DRIVER_IS_CLASSIFIED_AT_ITS_EFFECTIVE_PATH").toBe(true);
  }
  const batch = await testCommandBatches(["--cwd", "packages/ui-server", "tests/workspace-lease.test.ts"], root);
  expect(batch[0]!.docker, "CWD_MUST_NOT_EXEMPT_ANOTHER_FILE").toBe(false);
});


test("an empty host settings directory does not count as a hidden settings mount", () => {
  const probe = `import importlib.util,json,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
links=json.dumps([{'ifname':'lo','flags':['UP']}]).encode()
def query(argv,**kwargs):return links if 'link' in argv else b'[]'
def mounted(fs):return '1 0 0:1 / /etc/claude-code rw - '+fs+' source rw\\n'
with patch.object(m.subprocess,'check_output',side_effect=query), patch.object(m.Path,'exists',return_value=True), patch.object(m.Path,'iterdir',return_value=iter([])):
 with patch.object(m.Path,'read_text',return_value=mounted('ext4')):assert not m.already_inside(), 'EMPTY_HOST_SETTINGS_MUST_NOT_BE_REUSED'
 with patch.object(m.Path,'read_text',return_value=mounted('tmpfs')):assert m.already_inside(), 'OWN_SETTINGS_MOUNT_IS_REUSABLE'
with patch.object(m.subprocess,'check_output',side_effect=query), patch.object(m.Path,'exists',return_value=False):assert m.already_inside()
`;
  const child = Bun.spawnSync(["/usr/bin/python3", "-B", "-I", "-S", "-c", probe, join(import.meta.dir, "../scripts/offline-command.py")], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

test("matching uid and gid accept overflow supplementary groups without sudo", () => {
  const probe = `import importlib.util,json,sys
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
calls=[]
def run(argv,**kwargs):
 calls.append(argv)
 return SimpleNamespace(returncode=0,stdout=json.dumps([1000,1000,[65534]]).encode())
with patch.object(m.os,'getuid',return_value=1000), patch.object(m.os,'getgid',return_value=1000), patch.object(m.os,'geteuid',return_value=1000), patch.object(m.os,'getgroups',return_value=[1000,27]), patch.object(m.shutil,'which',side_effect=lambda name:'/usr/bin/'+name), patch.object(m.subprocess,'run',side_effect=run):
 assert m.main(['/bin/true']) == 0
 assert '--map-current-user' in calls[-1], 'OVERFLOW_GROUPS_MUST_USE_UNPRIVILEGED_PATH'
 assert 'sudo' not in calls[-1][0]
 data=dict(unprivileged=True,uid=1000,gid=1000,groups=[1000,27],cwd='/',started='/fixture-started',argv=['/bin/true'],env={})
 with patch.object(m.os,'getgroups',return_value=[65534]), patch.object(m.ctypes,'CDLL') as libc, patch.object(m.os.path,'exists',return_value=False), patch.object(m.os,'chdir'), patch.object(m.Path,'touch'), patch.object(m.os,'execvpe') as execute:
  libc.return_value.mount.return_value=0
  m.setup(data)
  assert execute.called, 'OVERFLOW_GROUPS_MUST_REACH_PAYLOAD'
  data['unprivileged']=False
  try:m.setup(data)
  except RuntimeError:pass
  else:raise AssertionError('PRIVILEGED_SETUP_MUST_RESTORE_GROUPS')
`;
  const child = Bun.spawnSync(["/usr/bin/python3", "-B", "-I", "-S", "-c", probe, join(import.meta.dir, "../scripts/offline-command.py")], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
