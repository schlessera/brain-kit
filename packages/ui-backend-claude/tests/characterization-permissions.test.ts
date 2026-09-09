/**
 * This pins current behaviour so the 0.34.0 factory split can be proven
 * behaviour-preserving. Changing an assertion here is a behaviour change and
 * needs saying so.
 */

import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";

function backendFor(
  run: (options: Options) => AsyncGenerator<unknown>,
  decision: PermissionDecision
): {
  frames: ServerMessage[];
  permissionCalls: PermissionRequest[];
  start(): Promise<void>;
} {
  const frames: ServerMessage[] = [];
  const permissionCalls: PermissionRequest[] = [];
  const bridge: BackendBridge = {
    emit: (frame) => frames.push(frame),
    requestPermission: async (request) => {
      permissionCalls.push(request);
      return decision;
    },
  };
  const queryFn = ((params: { options?: Options }) =>
    run(params.options!)) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", queryFn });
  return {
    frames,
    permissionCalls,
    start: () =>
      backend.startTurn({
        prompt: "characterize permissions",
        signal: new AbortController().signal,
        bridge,
      }),
  };
}

const init = {
  type: "system",
  subtype: "init",
  session_id: "permission-session",
};

const result = {
  type: "result",
  subtype: "success",
  session_id: "permission-session",
  total_cost_usd: 0,
  duration_ms: 1,
  num_turns: 1,
};

describe("createClaudeBackend permission characterization", () => {
  test("a non-allowlisted tool sends a tool request and returns edited input structurally", async () => {
    const originalInput = { query: "before", limit: 1 };
    let sdkDecision: unknown;
    const harness = backendFor(
      (options) =>
        (async function* () {
          yield init;
          sdkDecision = await options.canUseTool!(
            "mcp__external__search",
            originalInput,
            {
              signal: new AbortController().signal,
              toolUseID: "tool-allow",
              description: "Search the external catalog",
            } as never
          );
          yield result;
        })(),
      { behavior: "allow", updatedInput: { query: "after" } }
    );

    await harness.start();

    expect(harness.permissionCalls).toEqual([
      {
        toolUseId: "tool-allow",
        toolName: "mcp__external__search",
        input: { query: "before", limit: 1 },
        description: "Search the external catalog",
        kind: "tool",
      },
    ]);
    expect(sdkDecision).toEqual({
      behavior: "allow",
      updatedInput: { query: "after" },
    });
    expect(originalInput).toEqual({ query: "before", limit: 1 });
  });

  test("a denial is returned to the SDK with the host's literal message", async () => {
    let sdkDecision: unknown;
    const harness = backendFor(
      (options) =>
        (async function* () {
          yield init;
          sdkDecision = await options.canUseTool!(
            "mcp__external__publish",
            { id: 7 },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-deny",
            } as never
          );
          yield result;
        })(),
      { behavior: "deny", message: "Publishing was not approved." }
    );

    await harness.start();

    expect(harness.permissionCalls).toEqual([
      {
        toolUseId: "tool-deny",
        toolName: "mcp__external__publish",
        input: { id: 7 },
        description: undefined,
        kind: "tool",
      },
    ]);
    expect(sdkDecision).toEqual({
      behavior: "deny",
      message: "Publishing was not approved.",
    });
  });

  test("an allowlisted Bash confirm-pattern call asks as a command", async () => {
    let hookOutput: unknown;
    const commandInput = { command: "git reset --hard HEAD~1" };
    const harness = backendFor(
      (options) =>
        (async function* () {
          yield init;
          const matcher = options.hooks?.PreToolUse?.[0];
          if (!matcher)
            throw new Error("missing mutating-tool PreToolUse hook");
          hookOutput = await matcher.hooks[0]!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: commandInput,
              tool_use_id: "bash-confirm",
            } as never,
            "bash-confirm",
            { signal: new AbortController().signal }
          );
          yield result;
        })(),
      {
        behavior: "allow",
        updatedInput: { command: "git status --short" },
      }
    );

    await harness.start();

    expect(harness.permissionCalls).toEqual([
      {
        toolUseId: "bash-confirm",
        toolName: "Bash",
        input: { command: "git reset --hard HEAD~1" },
        description:
          "This command matches a pattern configured to require confirmation.",
        kind: "command",
      },
    ]);
    expect(commandInput).toEqual({ command: "git reset --hard HEAD~1" });
    expect(hookOutput).toEqual({ continue: true });
  });

  test("a denied Bash confirmation becomes a PreToolUse denial", async () => {
    let hookOutput: unknown;
    const harness = backendFor(
      (options) =>
        (async function* () {
          yield init;
          const matcher = options.hooks?.PreToolUse?.[0];
          if (!matcher)
            throw new Error("missing mutating-tool PreToolUse hook");
          hookOutput = await matcher.hooks[0]!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: "rm -rf notes" },
              tool_use_id: "bash-deny",
            } as never,
            "bash-deny",
            { signal: new AbortController().signal }
          );
          yield result;
        })(),
      { behavior: "deny", message: "Keep the notes." }
    );

    await harness.start();

    expect(hookOutput).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Keep the notes.",
      },
    });
  });
});
