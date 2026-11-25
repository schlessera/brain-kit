import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const env = cleanTestEnvironment({ PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "odysseus-fixture-key", OPENAI_API_KEY: "odysseus-fixture-key", CLAUDE_CODE_OAUTH_TOKEN: "odysseus-fixture-token" });
  expect(env).toEqual({ PATH: "/usr/bin:/bin" });
});


test("guarded Bun children do not autoload provider credentials from a fixture dotenv", () => {
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-child-env-"));
  try {
    writeFileSync(join(scratch, ".env"), "ANTHROPIC_API_KEY=odysseus-fixture-key\n");
    const child = Bun.spawnSync([process.execPath, "-e", "if(process.env.ANTHROPIC_API_KEY)throw Error('BUN_CHILD_DOTENV_MUST_NOT_LOAD_CREDENTIALS')"], {
      cwd: scratch, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
