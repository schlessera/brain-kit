/**
 * `brain sync` picks its verb from the positional arguments, so the
 * output-mode flags may come before it (#353).
 */
import { describe, expect, test } from "bun:test";
import { syncCommand } from "../src/cli/commands/sync.js";
import type { AgentRunner } from "../src/lib/seams.js";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

describe("sync verb selection", () => {
  test("`brain sync --json assess` runs assess", async () => {
    const root = makeTempBrain();
    try {
      expect(Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]).exitCode).toBe(0);
      const result = await runCli(root, ["sync", "--json", "assess"]);
      expect(result.stderr).not.toContain("Unknown sync verb");
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.branch).toBe("main");
      expect(body.files.length).toBeGreaterThan(0);
    } finally { cleanup(root); }
  });

  test("`brain sync --json` with no verb hands off to the agent", async () => {
    const prompts: string[] = [];
    const agentRunner: AgentRunner = {
      id: "stub",
      capabilities: { streaming: false, skills: true },
      async run(prompt) { prompts.push(prompt); return ""; },
    };
    const cli = { brain: { root: "/nonexistent-brain" }, json: true, agentRunner } as never;
    const error = await syncCommand.run(["--json"], cli).then(() => undefined, (e: Error) => e.message);
    expect(prompts).toEqual(["/sync"]);
    expect(error).toBeUndefined();
  });
});
