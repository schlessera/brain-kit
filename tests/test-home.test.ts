import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHomeSnapshot, createInvokingTestHome, installTestHome } from "../scripts/test-home";

for (const configPresent of [false, true]) {
  test(`test home restores environment descriptors with config ${configPresent ? "set" : "absent"} and snapshots detect host overwrites`, () => {
    const descriptors = new Map(["HOME", "CLAUDE_CONFIG_DIR"].map(name => [name, Object.getOwnPropertyDescriptor(process.env, name)]));
    const root = mkdtempSync(join(tmpdir(), "odysseus-test-home-"));
    const config = join(root, ".claude"); mkdirSync(config);
    const sentinel = join(config, "sentinel"); writeFileSync(sentinel, "Ithaca\n");
    process.env.HOME = root;
    if (configPresent) process.env.CLAUDE_CONFIG_DIR = config;
    else delete process.env.CLAUDE_CONFIG_DIR;
    const before = ["HOME", "CLAUDE_CONFIG_DIR"].map(name => Object.getOwnPropertyDescriptor(process.env, name));
    const isolated = installTestHome();
    try {
      expect(process.env.HOME).toBe(join(isolated.root, "home"));
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(isolated.root, "home/.claude"));
      const baseline = claudeHomeSnapshot(root);
      // Same path and byte count: a directory-count-only guard misses this.
      writeFileSync(sentinel, "Troy!!\n");
      expect(readFileSync(sentinel, "utf8")).toBe("Troy!!\n");
      expect(claudeHomeSnapshot(root)).not.toBe(baseline);
    } finally {
      isolated.dispose();
      try {
        expect(existsSync(isolated.root)).toBe(false);
        expect(["HOME", "CLAUDE_CONFIG_DIR"].map(name => Object.getOwnPropertyDescriptor(process.env, name))).toEqual(before);
      } finally {
        for (const [name, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(process.env, name, descriptor);
          else delete process.env[name];
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test("the invoking-home guard detects a same-size overwrite without adding paths", () => {
  const invoking = createInvokingTestHome();
  try {
    const sentinel = join(invoking.config, "sentinel");
    const bytes = readFileSync(sentinel);
    expect(bytes.toString()).toBe("Odysseus: invoking storage stays untouched.\n");
    invoking.assertUnchanged();
    writeFileSync(sentinel, Buffer.alloc(bytes.length, 120));
    expect(readFileSync(sentinel).length).toBe(bytes.length);
    expect(() => invoking.assertUnchanged()).toThrow("TEST_WROTE_INVOKING_CLAUDE_HOME");
  } finally { invoking.dispose(); }
  expect(existsSync(invoking.root)).toBe(false);
});

test("home isolation leaves filesystem originals and descriptors available to fixture spies", async () => {
  const fs = await import("node:fs");
  const descriptor = Object.getOwnPropertyDescriptor(fs, "mkdtempSync")!;
  const original = fs.mkdtempSync;
  const created: string[] = [];
  const observe = ((...args: Parameters<typeof original>) => {
    const path = Reflect.apply(original, fs, args);
    created.push(String(path));
    return path;
  }) as typeof original;
  const spy = spyOn(fs, "mkdtempSync").mockImplementation(observe);
  try {
    const path = fs.mkdtempSync(join(tmpdir(), "odysseus-home-spy-"));
    expect(existsSync(path)).toBe(true);
    expect(created).toEqual([path]);
  } finally {
    spy.mockRestore();
    Object.defineProperty(fs, "mkdtempSync", descriptor);
    for (const path of created) rmSync(path, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "failure", "cancel"] as const) test(`the launcher retains repeated-file resources until ${outcome}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-home-repetition-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const report = join(root, "report.jsonl");
    const harness = join(import.meta.dir, "../packages/core/tests/cli-harness.ts");
    for (const name of ["first", "last"]) {
      writeFileSync(join(root, `${name}.test.ts`), `
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keylessEnv } from ${JSON.stringify(harness)};
import { testLedgerFor } from ${JSON.stringify(join(import.meta.dir, "../scripts/host-admission.mjs"))};
import { processIdentity } from ${JSON.stringify(join(import.meta.dir, "../scripts/workspace-lease.mjs"))};
const state = globalThis as typeof globalThis & { odysseusHome?: string; odysseusUtility?: string };
state.odysseusHome ??= process.env.HOME;
state.odysseusUtility ??= keylessEnv("/odysseus").HOME;
test("every repetition retains owned storage", async () => {
  expect(process.env.HOME, "TEST_HOME_SURVIVES_REPETITION").toBe(state.odysseusHome);
  expect(existsSync(process.env.HOME!)).toBe(true);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(state.odysseusHome!, ".claude"));
  expect(existsSync(state.odysseusUtility!), "CLI_UTILITY_SURVIVES_REPETITION").toBe(true);
  expect(existsSync(process.env.BRAIN_HOST_ADMISSION_DIR!), "ADMISSION_SURVIVES_REPETITION").toBe(true);
  const own = testLedgerFor(process.pid, processIdentity(process.pid)!.start);
  expect(process.env.BRAIN_HOST_ADMISSION_DIR, "TEST_PROCESS_OWNS_ADMISSION").toBe(own);
  const descendant = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(`console.log((await import(${JSON.stringify(join(import.meta.dir, "../scripts/host-admission.mjs"))})).ledgerDir({}))`)}], { env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
  expect(descendant.exitCode, descendant.stderr.toString()).toBe(0);
  expect(descendant.stdout.toString().trim(), "ENVIRONMENT_FREE_DESCENDANT_FINDS_TEST_LEDGER").toBe(own);
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "prompt-context"), "Ithaca");
  appendFileSync(${JSON.stringify(report)}, JSON.stringify({ home: process.env.HOME, utility: state.odysseusUtility, admission: process.env.BRAIN_HOST_ADMISSION_DIR, bin: keylessEnv("/odysseus").XDG_BIN_HOME, path: keylessEnv("/odysseus").PATH }) + "\\n");
  if (${JSON.stringify(outcome)} === "failure") throw new Error("ODYSSEUS_EXPECTED_FAILURE");
  if (${JSON.stringify(outcome)} === "cancel") await Bun.sleep(60_000);
});`);
    }
    // Exercise the package command as a nested child too. Cancellation targets
    // the launcher directly, whose signal/group-drain contract this test proves.
    const entry = outcome === "cancel" ? [join(import.meta.dir, "../scripts/test.ts")] : ["run", "test"];
    const launched = Bun.spawn([process.execPath, ...entry, "--rerun-each=4", "--bail=1", join(root, "first.test.ts"), join(root, "last.test.ts")], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    child = launched;
    const output = Promise.all([new Response(launched.stdout).text(), new Response(launched.stderr).text(), launched.exited]);
    if (outcome === "cancel") {
      const deadline = Date.now() + 10_000;
      while (!existsSync(report) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
      expect(existsSync(report), "CANCELLATION_REACHED_TEST_BODY").toBe(true);
      child.kill("SIGTERM");
    }
    const [stdout, stderr, code] = await output;
    if (outcome === "success") expect(code, stdout + stderr).toBe(0);
    else expect(code, stdout + stderr).not.toBe(0);
    if (outcome === "failure") expect(stderr).toContain("ODYSSEUS_EXPECTED_FAILURE");
    const records = readFileSync(report, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(outcome === "success" ? 8 : 1);
    expect(new Set(records.map(record => record.home)).size).toBe(1);
    for (const record of records) for (const path of Object.values(record)) expect(existsSync(path as string)).toBe(false);
  } finally {
    if (child?.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested home disposal restores the live outer home's descriptors", () => {
  const outer = installTestHome();
  try {
    const before = ["HOME", "CLAUDE_CONFIG_DIR"].map(name => Object.getOwnPropertyDescriptor(process.env, name));
    const inner = installTestHome(outer.root);
    inner.dispose();
    expect(existsSync(inner.root)).toBe(false);
    expect(existsSync(outer.root)).toBe(true);
    expect(["HOME", "CLAUDE_CONFIG_DIR"].map(name => Object.getOwnPropertyDescriptor(process.env, name))).toEqual(before);
  } finally { outer.dispose(); }
});
