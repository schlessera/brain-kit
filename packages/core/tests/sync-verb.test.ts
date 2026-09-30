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

  test("`brain sync --json` with no verb is the bare sync, not a verb", async () => {
    // Off main the run fails before it touches anything, and a failure is
    // not something the agent is handed: only what the rules left is.
    const prompts: string[] = [];
    const agentRunner: AgentRunner = {
      id: "stub",
      capabilities: { streaming: false, skills: true },
      async run(prompt) { prompts.push(prompt); return ""; },
    };
    const cli = { brain: { root: "/nonexistent-brain", config: null }, json: true, agentRunner } as never;
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    const code = await syncCommand.run(["--json"], cli).finally(() => (console.log = log));
    expect(code).toBe(1);
    const body = JSON.parse(lines.join("\n"));
    expect(body.run.report).toStartWith("brain sync: failed — not on main branch");
    expect(body.agent).toEqual({ invoked: false, reason: "not-needed" });
    expect(prompts).toEqual([]);
  });
});
