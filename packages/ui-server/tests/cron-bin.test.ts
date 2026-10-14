import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { createUiDb } from "../src/db/client";
import { resolveCronConfig } from "../src/config/env.js";
import { MAINTENANCE_HOME } from "@schlessera/brain-ui-sdk/internal";

import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const BIN = resolve(import.meta.dir, "../src/bin/brain-ui-cron.ts");
const PRELOAD = resolve(import.meta.dir, "fixtures/cron-native-startup-preload.ts");
const nativeCleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of nativeCleanup.splice(0)) await close(); });
function nativeProcess(brain: string, args: string[], env: Record<string, string | undefined>, cwd?: string) {
  const fixture = createNativeAppFixture(brain); nativeCleanup.push(fixture.close);
  return Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "--preload", PRELOAD, BIN, ...args], {
    env: { ...env, BRAIN_PATH: brain, ...fixture.env }, ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
}
let directory: string;
let dbPath: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "brain-ui-cron-bin-"));
  dbPath = join(directory, "brain-ui.db");
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("brain-ui-cron subprocess", () => {
  test("native ownership settings reach the real emitted runner environment without entering scheduled child authority", async () => {
    const settings = { BRAIN_UI_NATIVE_BRAIN_SOCKET: "/run/odysseus/native.sock", BRAIN_UI_NATIVE_BRAIN_LEASE_PATH: "/var/lib/odysseus/native-leases.sqlite",
      BRAIN_UI_NATIVE_BRAIN_TIMEOUT_MS: "2000", BRAIN_UI_NATIVE_BRAIN_DELTA_BYTES: "32768" };
    const resolved = resolveCronConfig(settings);
    expect(resolved.nativeBrain).toEqual({ socketPath: settings.BRAIN_UI_NATIVE_BRAIN_SOCKET, leasePath: settings.BRAIN_UI_NATIVE_BRAIN_LEASE_PATH, timeoutMs: 2000, maxDeltaBytes: 32768 });
    for (const key of Object.keys(settings)) expect(resolved.childEnv, "NATIVE_MANAGER_AUTHORITY_STOPS_AT_CRON_RUNNER").not.toHaveProperty(key);
    const proc = Bun.spawn([process.execPath, BIN, "environment"], { env: { PATH: "/usr/bin:/bin", ...settings }, stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code, errors).toBe(0);
    for (const [key, value] of Object.entries(settings)) expect(output, "NATIVE_CRON_RUNNER_CONTROL_ENV_PRESERVED").toContain(`${key}="${value}"\n`);
    expect(errors).toBe("");
  });
  test("run records a row and returns the child's exit code", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brain = join(directory, "smoke-brain"); mkdirSync(brain);
    const proc = nativeProcess(brain, ["run", "smoke", "--", bun, "-e", "console.log('cron smoke'); process.exit(7)"], { PATH: process.env.PATH, DB_PATH: dbPath });

    expect(await proc.exited).toBe(7);
    expect(await new Response(proc.stdout).text()).toBe("cron smoke\n");
    const db = createUiDb(dbPath);
    const row = db
      .query("SELECT job_name, status, error_message FROM cron_runs WHERE job_name = ?")
      .get("smoke") as { job_name: string; status: string; error_message: string };
    expect(row.job_name).toBe("smoke");
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("exit code 7");
    db.close();
  });

  test("run re-admits a generated wrapper extra without forwarding the hatch", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brain = join(directory, "extra-brain"); mkdirSync(brain);
    const proc = nativeProcess(brain, ["run", "--subprocess-env-extra", " CUSTOM_CRON_TOKEN,bad-name,CUSTOM_CRON_TOKEN ", "extra-env", "--", bun, "-e",
      "console.log(JSON.stringify({ custom: process.env.CUSTOM_CRON_TOKEN, hatch: process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA, unknown: process.env.UNKNOWN_CHILD_VALUE }))"],
      { PATH: process.env.PATH, DB_PATH: dbPath, CUSTOM_CRON_TOKEN: "custom", UNKNOWN_CHILD_VALUE: "must-not-pass" });

    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({
      custom: "custom",
    });
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  test("no arguments prints usage on stderr and exits 2", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const proc = Bun.spawn([bun, BIN], { stdout: "pipe", stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe(
      "usage: brain-ui-cron run [--subprocess-env-extra <names>] <job-name> -- <command...>\n" +
        "       brain-ui-cron digest\n" +
        "       brain-ui-cron crontab [--wrapper-command <command>] [--digest-command <command>] [--path-line <line>] [--user <user>]\n" +
        "       brain-ui-cron environment\n"
    );
  });

  test("an unknown subcommand prints usage on stderr and exits 2", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const proc = Bun.spawn([bun, BIN, "unknown"], { stdout: "pipe", stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain("usage: brain-ui-cron run");
  });

  test("environment emits only the resolved cron audience", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const path = process.env.PATH ?? "/usr/bin";
    const proc = Bun.spawn([bun, BIN, "environment"], {
      env: {
        PATH: path,
        BRAIN_PATH: "/data/example-brain",
        NODE_ENV: "production",
        GITHUB_TOKEN: "example-token",
        ANTHROPIC_API_KEY: "excluded-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(
      `PATH="${path}"\nBRAIN_PATH="/data/example-brain"\nGITHUB_TOKEN="example-token"\n`
    );
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  test("environment carries the exec wrapper through to /etc/environment", async () => {
    // Through the real entrypoint, not `emitEnvironment` directly. The helper
    // was right and the wiring was wrong: `resolveCronConfig()` filters the
    // control variables out of `childEnv`, so the first version of this
    // emitted nothing and every scheduled job would have run unwrapped while
    // the unit test passed.
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const path = process.env.PATH ?? "/usr/bin";
    const proc = Bun.spawn([bun, BIN, "environment"], {
      env: {
        PATH: path,
        BRAIN_PATH: "/data/example-brain",
        BRAIN_UI_EXEC_WRAPPER: "/opt/run-as-agent",
        BRAIN_UI_EXEC_KILLER: "/opt/kill-agent-group",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(
      `PATH="${path}"\nBRAIN_PATH="/data/example-brain"\n` +
        `BRAIN_UI_EXEC_WRAPPER="/opt/run-as-agent"\n` +
        `BRAIN_UI_EXEC_KILLER="/opt/kill-agent-group"\n`
    );
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  test("crontab reads the resolved brain path and honors every deployment flag", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brainRoot = join(directory, "brain-root");
    mkdirSync(join(brainRoot, "scripts", "jobs"), { recursive: true });
    writeFileSync(join(brainRoot, "scripts", "jobs", "scrape-all.ts"), "");
    // On PATH for a host-run discovery, and in the brain's own bin directory,
    // which is all a maintenance worker resolves it from (#1648).
    for (const fakeBrain of [join(directory, "brain"), join(brainRoot, "node_modules", ".bin", "brain")]) {
      mkdirSync(dirname(fakeBrain), { recursive: true });
      writeFileSync(
        fakeBrain,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"enabled":[],"available":[]}\'\n'
      );
      chmodSync(fakeBrain, 0o755);
    }

    const proc = nativeProcess(brainRoot, ["crontab", "--wrapper-command", "/absolute/brain-ui-cron run", "--digest-command", "/absolute/brain-ui-cron digest", "--path-line", "PATH=/custom/bin", "--user", "cronuser"],
      { PATH: `${directory}:${process.env.PATH ?? ""}`, DB_PATH: dbPath });

    expect(await proc.exited).toBe(0);
    const output = await new Response(proc.stdout).text();
    expect(output).toContain("PATH=/custom/bin\n");
    expect(output).toContain(
      "cronuser cd / && /absolute/brain-ui-cron run sync --"
    );
    expect(output).toContain(
      "/absolute/brain-ui-cron run digest -- /absolute/brain-ui-cron digest"
    );
    expect(output).not.toContain("module list unavailable");
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  test("module discovery stays credential-free in managed workers regardless of runner cwd; scheduled commands use cron env", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brainRoot = join(directory, "audience-brain-root");
    const binDir = join(directory, "audience-bin");
    // In the brain: the one host directory a maintenance worker writes (#1648).
    const observedEnv = join(brainRoot, "module-discovery-env.txt");
    mkdirSync(brainRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    for (const fakeBrain of [join(binDir, "brain"), join(brainRoot, "node_modules", ".bin", "brain")]) {
      mkdirSync(dirname(fakeBrain), { recursive: true });
      writeFileSync(
        fakeBrain,
        "#!/bin/sh\n" +
          `printf '%s|%s|%s|%s|%s|%s|%s\\n' "$HOME" "$CLAUDE_CONFIG_DIR" "$ANTHROPIC_API_KEY" "\${DB_PATH-unset}" "$CUSTOM_DISCOVERY_TOKEN" "\${BRAIN_UI_SUBPROCESS_ENV_EXTRA-unset}" "\${UNKNOWN_CHILD_VALUE-unset}" > "\${BRAIN_WORKER_DATA_ROOT:-${brainRoot}}/module-discovery-env.txt"\n` +
          "printf '%s\\n' '{\"enabled\":[],\"available\":[]}'\n"
      );
      chmodSync(fakeBrain, 0o755);
    }

    const parentEnv = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      BRAIN_PATH: brainRoot,
      DB_PATH: dbPath,
      HOME: "/brain-cli/home",
      CLAUDE_CONFIG_DIR: "/brain-cli/claude",
      ANTHROPIC_API_KEY: "brain-cli-anthropic",
      CUSTOM_DISCOVERY_TOKEN: "operator-extra",
      BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CUSTOM_DISCOVERY_TOKEN",
      UNKNOWN_CHILD_VALUE: "must-not-pass",
    };
    // Managed repository evaluation remains isolated even when the runner's cwd is the brain.
    const emit = nativeProcess(brainRoot, ["crontab"], parentEnv, brainRoot);
    expect(await emit.exited).toBe(0);
    expect(await Bun.file(observedEnv).text(), "NATIVE_CRON_DISCOVERY_NEVER_HOST_EVALUATES").toBe(`${MAINTENANCE_HOME}|||unset||unset|unset\n`);
    expect(await new Response(emit.stderr).text()).toBe("");
    rmSync(observedEnv);
    const isolated = nativeProcess(brainRoot, ["crontab"], parentEnv, "/");
    expect(await isolated.exited).toBe(0);
    expect(await Bun.file(observedEnv).text()).toBe(`${MAINTENANCE_HOME}|||unset||unset|unset\n`);
    expect(await new Response(isolated.stderr).text()).toBe("");

    const run = nativeProcess(brainRoot, ["run", "--subprocess-env-extra", "CUSTOM_DISCOVERY_TOKEN", "audience-check", "--", bun, "-e",
      "console.log(JSON.stringify({ db: process.env.DB_PATH, home: process.env.HOME, claude: process.env.CLAUDE_CONFIG_DIR, anthropic: process.env.ANTHROPIC_API_KEY, custom: process.env.CUSTOM_DISCOVERY_TOKEN, unknown: process.env.UNKNOWN_CHILD_VALUE }))"], parentEnv);

    expect(await run.exited).toBe(0);
    expect(JSON.parse(await new Response(run.stdout).text())).toEqual({
      db: dbPath,
      custom: "operator-extra",
    });
    expect(await new Response(run.stderr).text()).toBe("");
  });

  /**
   * The bash tested `[ -f … ]`, true only for a regular file. A plain
   * existence check would also accept a directory and put a root cron line in
   * the crontab that the shell has always skipped.
   */
  async function crontabWithScraperAt(
    setup: (jobsDir: string) => void
  ): Promise<string> {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brainRoot = mkdtempSync(join(directory, "legacy-"));
    const jobsDir = join(brainRoot, "scripts", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    setup(jobsDir);
    const fakeBrain = join(directory, "brain");
    writeFileSync(
      fakeBrain,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"enabled":[],"available":[]}\'\n'
    );
    chmodSync(fakeBrain, 0o755);

    const localBrain = join(brainRoot, "node_modules/.bin/brain"); mkdirSync(dirname(localBrain), { recursive: true });
    writeFileSync(localBrain, '#!/bin/sh\nprintf \'%s\\n\' \'{"enabled":[],"available":[]}\'\n', { mode: 0o755 });
    const proc = nativeProcess(brainRoot, ["crontab"], { PATH: `${directory}:${process.env.PATH ?? ""}`, DB_PATH: dbPath });
    expect(await proc.exited).toBe(0);
    return await new Response(proc.stdout).text();
  }

  test("the legacy scraper fallback fires for a regular file", async () => {
    const output = await crontabWithScraperAt((jobsDir) => {
      writeFileSync(join(jobsDir, "scrape-all.ts"), "");
    });
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
  });

  test("a DIRECTORY at the scraper path does not schedule a root job", async () => {
    const output = await crontabWithScraperAt((jobsDir) => {
      mkdirSync(join(jobsDir, "scrape-all.ts"));
    });
    expect(output).not.toContain("scrape-all.ts --api-only");
  });

  test("a missing scraper path does not schedule a root job", async () => {
    const output = await crontabWithScraperAt(() => {});
    expect(output).not.toContain("scrape-all.ts --api-only");
  });

  test("a symlink to a regular file still counts as present", async () => {
    const output = await crontabWithScraperAt((jobsDir) => {
      const real = join(jobsDir, "real-scraper.ts");
      writeFileSync(real, "");
      symlinkSync(real, join(jobsDir, "scrape-all.ts"));
    });
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
  });
});


test("qualified native module discovery emits its repository-declared job", async () => {
  const brain = join(directory, "module-job-brain"), bin = join(brain, "node_modules/.bin/brain");
  mkdirSync(dirname(bin), { recursive: true });
  const modules = { enabled: [{ name: "harbor", key: "harbor", description: null, types: [], commands: [], cron: [{ name: "watch", schedule: "12 * * * *", command: "harbor watch" }] }], available: [] };
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(modules)}'\n`, { mode: 0o755 });
  const proc = nativeProcess(brain, ["crontab", "--wrapper-command", "/absolute/brain-ui-cron run"], { PATH: process.env.PATH, DB_PATH: dbPath });
  const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, errors).toBe(0);
  expect(output, "NATIVE_CRON_REAL_MODULE_DISCOVERY_EMITTED_JOB").toContain("run harbor-watch -- brain harbor watch");
  expect(output).toContain("12 * * * *");
  expect(errors).toBe("");
});

test("repository job without native qualification refuses before creating UI state or executing child", async () => {
  const brain = join(directory, "refused-brain"), state = join(directory, "refused-ui.sqlite"), sentinel = join(directory, "refused-child"); mkdirSync(brain);
  const proc = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", BIN, "run", "refused", "--", process.execPath, "-e", `await Bun.write(${JSON.stringify(sentinel)}, "executed")`],
    { env: { PATH: process.env.PATH, BRAIN_PATH: brain, DB_PATH: state }, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, "NATIVE_CRON_RUN_REFUSES_UNQUALIFIED_STORAGE").not.toBe(0);
  expect(errors).toContain("require configured managed Btrfs storage");
  expect(output).toBe("");
  expect(existsSync(state), "NATIVE_CRON_REFUSAL_CREATES_NO_UI_DATABASE").toBe(false);
  expect(existsSync(sentinel), "NATIVE_CRON_REFUSAL_EXECUTES_NO_REPOSITORY_JOB").toBe(false);
});

test("crontab without native qualification emits core jobs and explicitly reports unavailable module discovery", async () => {
  const brain = join(directory, "unavailable-modules-brain"), bin = join(brain, "node_modules/.bin/brain"), sentinel = join(directory, "unavailable-discovery"); mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\nprintf evaluated > ${JSON.stringify(sentinel)}\nprintf '%s\\n' '{"enabled":[],"available":[]}'\n`, { mode: 0o755 });
  const state = join(directory, "unavailable-modules-ui.sqlite");
  const proc = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", BIN, "crontab", "--wrapper-command", "/absolute/brain-ui-cron run"], { env: { PATH: process.env.PATH, BRAIN_PATH: brain, DB_PATH: state }, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, errors).toBe(0);
  expect(output).toContain("run sync --");
  expect(output).toContain("run digest --");
  expect(errors, "NATIVE_CRON_MODULE_DISCOVERY_UNAVAILABLE_IS_EXPLICIT").toContain("module discovery unavailable; emitting core jobs only");
  expect(existsSync(sentinel), "NATIVE_CRON_FALLBACK_NEVER_HOST_EVALUATES_BRAIN").toBe(false);
  expect(existsSync(state)).toBe(false);
});
