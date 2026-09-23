/**
 * The binary option the SDK receives (#213): no `claudeCodePath` leaves
 * `pathToClaudeCodeExecutable` out, so the SDK runs its built-in binary; a
 * configured one reaches it unchanged.
 */
import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeBackend } from "../src/backend";

async function optionsFor(claudeCodePath?: string): Promise<Options | undefined> {
  let captured: Options | undefined;
  const queryFn = ((params: { options?: Options }) => {
    captured = params.options;
    return (async function* () {
      yield { type: "result", subtype: "success", session_id: "s", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", queryFn, ...(claudeCodePath ? { claudeCodePath } : {}) });
  await backend
    .startTurn({
      prompt: "hi",
      signal: new AbortController().signal,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) },
    })
    .catch(() => {});
  return captured;
}

describe("pathToClaudeCodeExecutable", () => {
  test("is absent when no path is configured", async () => {
    const options = await optionsFor();
    expect(options).toBeDefined();
    expect(Object.hasOwn(options!, "pathToClaudeCodeExecutable")).toBe(false);
  });

  test("is the configured path, unchanged", async () => {
    expect((await optionsFor("/opt/claude/bin/claude"))?.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude");
  });
});
