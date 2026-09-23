/**
 * The Claude runner's stream-json protocol, against a scripted stand-in for
 * the CLI (#253). The live half — what the real binary sends — is
 * claude-runner-subscription.test.ts, whose loopback server always answers
 * 400; this covers what a live run there cannot: a successful run's output,
 * and exactly what the runner writes to the CLI before and after the
 * handshake.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claudeRunner } from "../src/providers/agents/cli-runners";
import { ClaudeSubscriptionError } from "../src/providers/agents/claude-subscription";

const scratch: string[] = [];
const savedPath = process.env.PATH;
const savedClaudeCodePath = process.env.CLAUDE_CODE_PATH;

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedClaudeCodePath === undefined) delete process.env.CLAUDE_CODE_PATH;
  else process.env.CLAUDE_CODE_PATH = savedClaudeCodePath;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Put a fake `claude` in CLAUDE_CODE_PATH that logs every stdin line to `log`, answers the
 * handshake with `account`, and answers a user message with `result`.
 */
function fakeClaude(
  account: Record<string, string>,
  result: string | null,
  settings: unknown = { effective: {}, sources: [] }
): { log: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  scratch.push(dir);
  const log = join(dir, "stdin.log");
  const script = join(dir, "claude");
  writeFileSync(
    script,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
out({ type: "system", subtype: "noise" });
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    appendFileSync(${JSON.stringify(log)}, line + "\\n");
    const event = JSON.parse(line);
    if (event.type === "control_request" && event.request.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: "someone-else", response: {} } });
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: { account: ${JSON.stringify(account)} } } });
    } else if (event.type === "control_request" && event.request.subtype === "get_settings") {
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: ${JSON.stringify(settings)} } });
    } else if (event.type === "user") {
      out({ type: "system", subtype: "init" });
      out({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
      if (${JSON.stringify(result)} === null) process.exit(0);
      out({ type: "result", subtype: "success", result: ${JSON.stringify(result)} });
    }
  }
}
`
  );
  chmodSync(script, 0o755);
  // The runner takes CLAUDE_CODE_PATH first, as chat does (#213).
  process.env.CLAUDE_CODE_PATH = script;
  process.env.PATH = `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  return { log, cwd: dir };
}

function written(log: string): Array<{ type: string; request?: { subtype: string } }> {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const OAUTH_ACCOUNT = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };

describe("the Claude runner's protocol", () => {
  test("run() returns the result text, trimmed, after one handshake and one prompt", async () => {
    const { log, cwd } = fakeClaude(OAUTH_ACCOUNT, "  the answer  ");
    const text = await claudeRunner().run("hi", { cwd });

    expect(text).toBe("the answer");
    const lines = written(log);
    expect(lines.map((line) => line.type)).toEqual(["control_request", "control_request", "user"]);
    expect(lines.map((line) => line.request?.subtype)).toEqual(["initialize", "get_settings", undefined]);
  });

  test("runStreaming() reports assistant text as it arrives", async () => {
    const { cwd } = fakeClaude(OAUTH_ACCOUNT, "done");
    const events: string[] = [];
    const text = await claudeRunner().runStreaming!("hi", {
      cwd,
      onEvent: (event) => events.push(`${event.kind}:${event.label}`),
    });

    expect(text).toBe("done");
    expect(events).toEqual(["text:working"]);
  });

  test("an API-key account is refused and the prompt is never written", async () => {
    const { log, cwd } = fakeClaude({ ...OAUTH_ACCOUNT, apiKeySource: "ANTHROPIC_API_KEY" }, "unused");

    await expect(claudeRunner().run("hi", { cwd })).rejects.toBeInstanceOf(
      ClaudeSubscriptionError
    );
    expect(written(log).map((line) => line.type)).toEqual(["control_request", "control_request"]);
  });

  test("settings that configure a helper are refused and the prompt is never written", async () => {
    const { log, cwd } = fakeClaude(OAUTH_ACCOUNT, "unused", {
      effective: { apiKeyHelper: "" },
      sources: [{ source: "policySettings", settings: { apiKeyHelper: "echo key" } }],
    });

    await expect(claudeRunner().run("hi", { cwd })).rejects.toBeInstanceOf(ClaudeSubscriptionError);
    expect(written(log).map((line) => line.type)).toEqual(["control_request", "control_request"]);
  });

  test("a CLI that exits cleanly without a result is a failed run, not an empty answer", async () => {
    const { cwd } = fakeClaude(OAUTH_ACCOUNT, null);
    await expect(claudeRunner().run("hi", { cwd })).rejects.toThrow("ended without a result");
  });
});
