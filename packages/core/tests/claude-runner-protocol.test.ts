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

afterEach(() => {
  process.env.PATH = savedPath;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Put a fake `claude` on PATH that logs every stdin line to `log`, answers the
 * handshake with `account`, and answers a user message with `result`.
 */
function fakeClaude(account: Record<string, string>, result: string): { log: string; cwd: string } {
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
    if (event.type === "control_request") {
      out({ type: "control_response", response: { subtype: "success", request_id: "someone-else", response: {} } });
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: { account: ${JSON.stringify(account)} } } });
    } else if (event.type === "user") {
      out({ type: "system", subtype: "init" });
      out({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
      out({ type: "result", subtype: "success", result: ${JSON.stringify(result)} });
    }
  }
}
`
  );
  chmodSync(script, 0o755);
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
const managedSettingsDir = mkdtempSync(join(tmpdir(), "fake-managed-"));

describe("the Claude runner's protocol", () => {
  test("run() returns the result text, trimmed, after one handshake and one prompt", async () => {
    const { log, cwd } = fakeClaude(OAUTH_ACCOUNT, "  the answer  ");
    const text = await claudeRunner({ managedSettingsDir }).run("hi", { cwd });

    expect(text).toBe("the answer");
    const lines = written(log);
    expect(lines.map((line) => line.type)).toEqual(["control_request", "user"]);
    expect(lines[0]!.request?.subtype).toBe("initialize");
  });

  test("runStreaming() reports assistant text as it arrives", async () => {
    const { cwd } = fakeClaude(OAUTH_ACCOUNT, "done");
    const events: string[] = [];
    const text = await claudeRunner({ managedSettingsDir }).runStreaming!("hi", {
      cwd,
      onEvent: (event) => events.push(`${event.kind}:${event.label}`),
    });

    expect(text).toBe("done");
    expect(events).toEqual(["text:working"]);
  });

  test("an API-key account is refused and the prompt is never written", async () => {
    const { log, cwd } = fakeClaude({ ...OAUTH_ACCOUNT, apiKeySource: "ANTHROPIC_API_KEY" }, "unused");

    await expect(claudeRunner({ managedSettingsDir }).run("hi", { cwd })).rejects.toBeInstanceOf(
      ClaudeSubscriptionError
    );
    expect(written(log).map((line) => line.type)).toEqual(["control_request"]);
  });
});
