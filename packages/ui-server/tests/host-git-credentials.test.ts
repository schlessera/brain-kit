import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainManagerClient, runMaintenanceWorker } from "@schlessera/brain-ui-sdk/internal";
import { zipSync, strToU8 } from "fflate";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { syncTransportCommand } from "../src/brain/sync-mirror.js";
import { resolveGitHubToken } from "../src/config/env.js";
import { installSkillsFromGitHub } from "../src/skills/install.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-git-credentials-")); roots.push(root);
  const brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state, { mode: 0o700 });
  return { brain, state, dbPath: join(state, "ui.db") };
}

const hostEnv = {
  PATH: "/usr/bin:/bin",
  GITHUB_TOKEN: "odysseus-generic-git-token",
  BRAIN_UI_SYNC_GITHUB_TOKEN: "odysseus-sync-git-token",
  BRAIN_UI_SKILLS_GITHUB_TOKEN: "odysseus-skills-git-token",
  OPENAI_API_KEY: "odysseus-provider-key",
  TZ: "UTC",
};

for (const method of ["run", "launch"] as const) {
  test(`credentialed maintenance ${method} excludes the skills token and all host Git credentials`, async () => {
    const f = fixture();
    const native = createNativeAppFixture(f.brain); cleanup.push(native.close);
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: f.dbPath, exec: {},
      nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
    const env = { ...hostEnv };
    const program = `console.log(JSON.stringify({
      skills: process.env.BRAIN_UI_SKILLS_GITHUB_TOKEN ?? null,
      generic: process.env.GITHUB_TOKEN ?? null,
      sync: process.env.BRAIN_UI_SYNC_GITHUB_TOKEN ?? null,
      provider: process.env.OPENAI_API_KEY, tz: process.env.TZ,
      mount: require("node:fs").readlinkSync("/proc/self/ns/mnt")
    }));`;
    const execution = { argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program],
      env, credentials: true, gate: "exclusive" as const, purpose: "Odysseus credentialed maintenance" };
    let stdout: string, stderr: string, exitCode: number;
    if (method === "run") ({ stdout, stderr, exitCode } = await boundary.run(execution));
    else {
      const child = await boundary.launch(execution);
      [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    }
    expect(exitCode, stderr).toBe(0);
    const observed = JSON.parse(stdout);
    expect(observed.skills, "SKILLS_TOKEN_ABSENT_FROM_CREDENTIALED_MAINTENANCE").toBeNull();
    expect(observed.generic).toBeNull();
    expect(observed.sync).toBeNull();
    expect(observed.provider, "PROVIDER_CREDENTIAL_STILL_REACHES_MAINTENANCE").toBe(hostEnv.OPENAI_API_KEY);
    expect(observed.tz).toBe("UTC");
    expect(observed.mount, "ACTUAL_MAINTENANCE_NAMESPACE").not.toBe(readlinkSync("/proc/self/ns/mnt"));
    expect(env, "HOST_CREDENTIAL_SOURCES_UNCHANGED").toEqual(hostEnv);
  });
}

for (const dedicated of [true, false]) {
  test(`mirror transport authenticates with the ${dedicated ? "sync" : "fallback"} token after worker filtering`, async () => {
    const f = fixture(), mirror = join(f.state, "mirror.git");
    const init = Bun.spawnSync(["/usr/bin/git", "init", "--bare", mirror], { env: { PATH: hostEnv.PATH }, stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode, init.stderr.toString()).toBe(0);
    const env = { ...hostEnv, BRAIN_UI_SYNC_GITHUB_TOKEN: dedicated ? hostEnv.BRAIN_UI_SYNC_GITHUB_TOKEN : undefined };
    const transport = syncTransportCommand({ brain: f.brain, mirror,
      remote: "https://github.com/odyssey-fixtures/brain.git", env, args: ["credential", "fill"], tempDomain: { statePath: f.dbPath } });
    // Git's real credential helper consumes the transported token without
    // contacting a remote; repository inputs never enter this worker.
    const result = await runMaintenanceWorker({ ...transport, stdin: "protocol=https\nhost=github.com\n\n" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`password=${dedicated ? hostEnv.BRAIN_UI_SYNC_GITHUB_TOKEN : hostEnv.GITHUB_TOKEN}\n`);
    expect(result.stdout).not.toContain(hostEnv.BRAIN_UI_SKILLS_GITHUB_TOKEN);
    expect(result.stdout).not.toContain(hostEnv.OPENAI_API_KEY);
  });

  test(`skills installer authenticates with the ${dedicated ? "skills" : "fallback"} token`, async () => {
    const f = fixture();
    const env = { ...hostEnv, BRAIN_UI_SKILLS_GITHUB_TOKEN: dedicated ? hostEnv.BRAIN_UI_SKILLS_GITHUB_TOKEN : undefined };
    const authorizations: Array<string | null> = [];
    const outcomes = await installSkillsFromGitHub({ brainPath: f.brain }, { owner: "odyssey-fixtures", repo: "skills" }, {
      token: resolveGitHubToken(env),
      fetcher: async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return new Response(Buffer.from(zipSync({ "odyssey-skills/harbor/SKILL.md": strToU8("---\nname: harbor\ndescription: Review the harbor log.\n---\n\nOdysseus reviews the harbor log.\n") })));
      },
    });
    expect(authorizations).toEqual([`Bearer ${dedicated ? hostEnv.BRAIN_UI_SKILLS_GITHUB_TOKEN : hostEnv.GITHUB_TOKEN}`]);
    expect(outcomes).toEqual([{ name: "harbor", status: "installed", files: 1 }]);
  });
}
