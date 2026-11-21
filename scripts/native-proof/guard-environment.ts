/** Propagate qualification context, never credentials, into offline proof containers. */
import { resolve } from "node:path";

export function nativeGuardEnvironment(): string[] {
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const head = git.stdout.toString().trim();
  if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(head)) throw Error("Native proof requires an exact checkout head");
  return [`--env=BRAIN_NATIVE_TEST_HEAD=${head}`,
    ...(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted"
      ? ["--env=GITHUB_ACTIONS=true", "--env=RUNNER_ENVIRONMENT=github-hosted"] : [])];
}
