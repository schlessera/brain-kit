import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Result = { code: number | null; out: string; err: string };
type Environment = Record<string, string | undefined>;

const fixtureEnv = (): Environment => ({
  PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Odysseus", GIT_COMMITTER_NAME: "Odysseus",
  GIT_AUTHOR_EMAIL: "odysseus@example.com", GIT_COMMITTER_EMAIL: "odysseus@example.com",
  GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z",
  GIT_TRACE: "1",
});

function git(root: string, env: Environment, ...args: string[]): Result {
  const child = Bun.spawnSync(["git", "-C", root, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}

async function commit(root: string, env: Environment, mode: string): Promise<Result> {
  const cmd = ["git", "-C", root, "commit", "--allow-empty", "-m", "Odysseus prepares the voyage"];
  if (mode === "sync-array" || mode === "sync-object") {
    const child = mode === "sync-array"
      ? Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" })
      : Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
  }
  if (mode === "node-child-process") {
    const child = spawnSync(cmd[0]!, cmd.slice(1), { env, encoding: "utf8" });
    return { code: child.status, out: child.stdout, err: child.stderr };
  }
  if (mode === "shell") cmd.unshift("sh", "-c", 'exec "$@"', "fixture-git");
  if (mode === "bun-child") {
    const source = `const child = Bun.spawnSync(${JSON.stringify(cmd)}, { env: ${JSON.stringify(env)}, stdout: "inherit", stderr: "inherit" }); process.exit(child.exitCode);`;
    cmd.splice(0, cmd.length, process.execPath, "-e", source);
  }
  const child = mode === "async-object"
    ? Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" })
    : Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

for (const mode of ["sync-array", "sync-object", "async-array", "async-object", "node-child-process", "shell", "bun-child"]) {
  test(`${mode}: a fixture commit cannot start automatic maintenance with a replaced environment`, async () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-git-maintenance-"));
    const env = fixtureEnv();
    try {
      for (const args of [["init", "-b", "main"], ["config", "--local", "maintenance.auto", "true"],
        // Keep the failing-first/mutation control synchronous so it cannot
        // leave a detached process using a fixture after teardown.
        ["config", "--local", "maintenance.autoDetach", "false"]]) {
        const result = git(root, env, ...args);
        expect(result.code, result.err).toBe(0);
      }
      const result = await commit(root, env, mode);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain("Odysseus prepares the voyage");
      expect(result.err).toContain("trace:");
      expect(result.err).not.toMatch(/\b(?:maintenance run|gc --auto)\b/);
      expect(git(root, env, "config", "--get", "maintenance.auto").out.trim()).toBe("false");
      expect(git(root, env, "config", "--get", "gc.auto").out.trim()).toBe("0");
      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("fixture Git policy preserves existing command configuration and caller environment", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-git-config-"));
  const env = { ...fixtureEnv(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "fixture.vessel", GIT_CONFIG_VALUE_0: "raft" };
  try {
    expect(git(root, env, "init", "-b", "main").code).toBe(0);
    const value = git(root, env, "config", "--get", "fixture.vessel");
    expect(value.code, value.err).toBe(0);
    expect(value.out.trim()).toBe("raft");
    expect(git(root, env, "config", "--get", "maintenance.auto").out.trim()).toBe("false");
    expect(git(root, env, "config", "--get", "gc.auto").out.trim()).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
