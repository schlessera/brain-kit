import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintenanceLaunch } from "../src/server/maintenance-worker.js";
import { workerCommand } from "../src/server/worker-launcher.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const hostEnv = {
  PATH: "/usr/bin:/bin",
  GITHUB_TOKEN: "odysseus-generic-git-token",
  BRAIN_UI_SYNC_GITHUB_TOKEN: "odysseus-sync-git-token",
  BRAIN_UI_SKILLS_GITHUB_TOKEN: "odysseus-skills-git-token",
  OPENAI_API_KEY: "odysseus-provider-key",
};

for (const credentials of [true, false]) {
  test(`${credentials ? "credentialed" : "credential-free"} SDK maintenance strips every host Git credential`, () => {
    const env = { ...hostEnv };
    const launch = maintenanceLaunch({ brainPath: "/odysseus/brain", command: ["/bin/true"], env, credentials });
    expect(launch.env.BRAIN_UI_SKILLS_GITHUB_TOKEN, "SDK_MAINTENANCE_SKILLS_TOKEN_ABSENT").toBeUndefined();
    expect(launch.env.GITHUB_TOKEN).toBeUndefined();
    expect(launch.env.BRAIN_UI_SYNC_GITHUB_TOKEN).toBeUndefined();
    if (credentials) expect(launch.env.OPENAI_API_KEY).toBe(hostEnv.OPENAI_API_KEY);
    else expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(env).toEqual(hostEnv);
  });
}

for (const maintenance of [false, true]) {
  test(`direct ${maintenance ? "maintenance" : "agent"} worker launch strips host Git credentials`, () => {
    const root = mkdtempSync(join(tmpdir(), "odysseus-worker-git-credentials-")); roots.push(root);
    const brain = join(root, "brain"); mkdirSync(brain);
    const program = `console.log(JSON.stringify({ skills: process.env.BRAIN_UI_SKILLS_GITHUB_TOKEN ?? null,
      generic: process.env.GITHUB_TOKEN ?? null, sync: process.env.BRAIN_UI_SYNC_GITHUB_TOKEN ?? null,
      provider: process.env.OPENAI_API_KEY }));`;
    const argv = workerCommand({ brainPath: brain, command: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program],
      env: hostEnv, ...(maintenance ? { maintenance: { credentials: true, network: true, readPaths: [process.execPath] } } : {}) });
    const result = Bun.spawnSync(argv, { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()), "DIRECT_WORKER_HAS_ONLY_ITS_PROVIDER_CREDENTIAL").toEqual({
      skills: null, generic: null, sync: null, provider: hostEnv.OPENAI_API_KEY,
    });
  });
}
