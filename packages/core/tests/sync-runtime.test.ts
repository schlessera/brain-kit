/**
 * `brain sync --json` through the real bin, with a scripted stand-in for the
 * `claude` CLI (#290): stdout is one parseable result, the version the CLI's
 * `init` reported arrives unchanged, a run the rules finish never launches
 * the CLI, and human mode keeps the report and the agent's text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./cli-harness";
import { brainWithRemote, cleanupFixtures, SCENARIO_SETUPS } from "./sync-fixture";

const scratch: string[] = [];
afterEach(() => {
  cleanupFixtures();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const { sameNote, codeConflict } = SCENARIO_SETUPS;

/**
 * A fake `claude`: answers the handshake as a subscription, then, for the
 * prompt, reports `init` (with `version` when given), a tool call and some
 * text, and ends with a result — or, with `fail`, exits 1 without one.
 * `launched` exists once it has been started at all.
 */
function fakeClaude(opts: { version?: string; fail?: boolean }): { env: Record<string, string>; launched: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-sync-"));
  scratch.push(dir);
  const launched = join(dir, "launched");
  const script = join(dir, "claude");
  const init = opts.version === undefined ? {} : { claude_code_version: opts.version };
  writeFileSync(
    script,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(launched)}, "");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "control_request" && event.request.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: { account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } } } });
    } else if (event.type === "control_request" && event.request.subtype === "get_settings") {
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: { effective: {}, sources: [] } } });
    } else if (event.type === "user") {
      out({ type: "system", subtype: "init", ...${JSON.stringify(init)} });
      out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }, { type: "text", text: "looking" }] } });
      if (${JSON.stringify(!!opts.fail)}) { process.stderr.write("fake claude gave up\\n"); process.exit(1); }
      out({ type: "result", subtype: "success", result: "the agent's final word" });
    }
  }
}
`
  );
  chmodSync(script, 0o755);
  return { env: { CLAUDE_CODE_PATH: script }, launched };
}

describe("brain sync --json, end to end (#290)", () => {
  test("a conflict for the agent: one JSON document, and the fake CLI's init version unchanged", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const claude = fakeClaude({ version: "9.8.7-fake" });
    const result = await runCli(brain.root, ["sync", "--json"], claude.env);

    expect(result.code).toBe(0);
    // The whole of stdout is the result: no report, no progress, no agent text beside it.
    const body = JSON.parse(result.stdout);
    expect(body.run.status).toBe("needs-judgment");
    expect(body.agent).toEqual({
      invoked: true,
      runner: "claude",
      outcome: "success",
      runtime: { name: "claude-code", version: "9.8.7-fake" },
      text: "the agent's final word",
    });
    expect(result.stderr).not.toContain("Bash: git status");
  });

  test("an init without a version: invoked, version unknown", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const claude = fakeClaude({});
    const body = JSON.parse((await runCli(brain.root, ["sync", "--json"], claude.env)).stdout);
    expect(body.agent).toMatchObject({ invoked: true, runtime: { name: "claude-code", version: null } });
  });

  test("a CLI that fails after init: exit 2 as before, one JSON document, the version kept", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const claude = fakeClaude({ version: "9.8.7-fake", fail: true });
    const result = await runCli(brain.root, ["sync", "--json"], claude.env);

    expect(result.code).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body.agent.invoked).toBe(true);
    expect(body.agent.outcome).toBe("failed");
    expect(body.agent.runtime).toEqual({ name: "claude-code", version: "9.8.7-fake" });
    expect(body.agent.error).toContain("claude CLI failed (exit 1)");
    expect(result.stderr).toContain("claude CLI failed (exit 1)");
  });

  test("a sync the rules finish never launches the CLI to learn a version", async () => {
    const brain = brainWithRemote();
    sameNote(brain);
    const claude = fakeClaude({ version: "9.8.7-fake" });
    const result = await runCli(brain.root, ["sync", "--json"], claude.env);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.run.status).toBe("complete");
    expect(body.agent).toEqual({ invoked: false, reason: "not-needed" });
    expect(existsSync(claude.launched)).toBe(false);
  });

  test("human mode keeps the report, then the agent's text, and the progress on stderr", async () => {
    const brain = brainWithRemote();
    codeConflict(brain);
    const claude = fakeClaude({ version: "9.8.7-fake" });
    const result = await runCli(brain.root, ["sync", "--human"], claude.env);

    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("brain sync: needs-judgment");
    expect(result.stdout.trimEnd()).toEndWith("the agent's final word");
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stderr).toContain("Bash: git status");
  });
});
