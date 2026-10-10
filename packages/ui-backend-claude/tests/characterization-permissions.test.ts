import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
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
import { MUTATING_TOOL_MATCHER } from "../src/tool-policy";

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
    // BEHAVIOUR CHANGE, twice. Before #122 this returned a bare
    // `{ continue: true }` and ran the ORIGINAL command, silently discarding
    // the host's edit; #122 refused the edit instead, believing the SDK
    // honours `updatedInput` only with `permissionDecision: "allow"`. It does
    // not (measured for #124 and #145), so since #145 an edit that passes the
    // re-check against the shared policy is applied — `updatedInput`, no
    // decision. `git status --short` needs no confirmation, so it passes.
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
        // The matched pattern's effect, in words (#112), not a generic
        // "a pattern matched".
        description: "discard every uncommitted change in the working tree",
        kind: "command",
      },
    ]);
    expect(commandInput).toEqual({ command: "git reset --hard HEAD~1" });
    expect(hookOutput).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "git status --short" },
      },
    });
  });

  test("an unedited Bash confirmation still runs", async () => {
    let hookOutput: unknown;
    const harness = backendFor(
      (options) =>
        (async function* () {
          yield init;
          // By matcher, not index: an enforced turn prepends another hook
          // (#124). The cases above predate that and pin a non-enforced turn.
          const matcher = options.hooks?.PreToolUse?.find(
            (entry) => entry.matcher === MUTATING_TOOL_MATCHER
          );
          if (!matcher)
            throw new Error("missing mutating-tool PreToolUse hook");
          hookOutput = await matcher.hooks[0]!(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: "git reset --hard HEAD~1" },
              tool_use_id: "bash-plain-allow",
            } as never,
            "bash-plain-allow",
            { signal: new AbortController().signal }
          );
          yield result;
        })(),
      { behavior: "allow" }
    );

    await harness.start();

    expect(harness.permissionCalls).toHaveLength(1);
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

mockWorkerHostForSdkStream();
