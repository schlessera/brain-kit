/**
 * Archiving through the auto-allowed `brain_update`.
 *
 * The hole these close: archiving is confirmed because it is a VISIBILITY
 * change — an archived document drops out of search, briefings and context
 * assembly. Two paths to it stop for approval (`brain_archive` is off the
 * allowlist, `brain archive` matches a confirm pattern) and a third did not:
 * `brain_update` takes the same `status` field, sits on
 * DEFAULT_ALLOWED_TOOLS, and the SDK never consults `canUseTool` for an
 * allowlisted tool — so `status: "archived"` made a document invisible with
 * no card at all.
 *
 * The other half of the bar is the negative one. This must not become a card
 * on every document edit: an update with no `status`, or with "active" or
 * "draft", has to stay silent, or the whole mechanism gets switched off.
 */
import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
} from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { BRAIN_UPDATE_TOOL, MUTATING_TOOL_MATCHER } from "../src/tool-policy";

const init = {
  type: "system",
  subtype: "init",
  session_id: "archive-gate",
};

const result = {
  type: "result",
  subtype: "success",
  session_id: "archive-gate",
  total_cost_usd: 0,
  duration_ms: 1,
  num_turns: 1,
};

/**
 * Drive the mutating-tool PreToolUse hook with one tool call, the way the SDK
 * does before it executes the tool, and report what the host was asked.
 */
async function preToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: PermissionDecision = { behavior: "allow" }
): Promise<{ output: unknown; permissionCalls: PermissionRequest[] }> {
  const permissionCalls: PermissionRequest[] = [];
  const bridge: BackendBridge = {
    emit: () => {},
    requestPermission: async (request) => {
      permissionCalls.push(request);
      return decision;
    },
  };
  let output: unknown;
  const queryFn = ((params: { options?: Options }) =>
    (async function* () {
      yield init;
      const matcher = params.options!.hooks?.PreToolUse?.[0];
      if (!matcher) throw new Error("missing mutating-tool PreToolUse hook");
      output = await matcher.hooks[0]!(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: "update-1",
        } as never,
        "update-1",
        { signal: new AbortController().signal }
      );
      yield result;
    })()) as unknown as typeof query;

  const backend = createClaudeBackend({ brainPath: "/brain", queryFn });
  await backend.startTurn({
    prompt: "archive gate",
    signal: new AbortController().signal,
    bridge,
  });
  return { output, permissionCalls };
}

describe("brain_update reaches the hook at all", () => {
  test("the mutating matcher covers the update tool", () => {
    // If it did not, the gate below would never run: the tool is auto-allowed,
    // so this hook is the ONLY place the call is seen before it executes.
    expect(new RegExp(MUTATING_TOOL_MATCHER).test(BRAIN_UPDATE_TOOL)).toBe(true);
  });
});

describe("an update that archives", () => {
  test("asks the host, as a per-use confirmation and not a tool grant", async () => {
    const input = { path: "notes/thing.md", status: "archived" };
    const { output, permissionCalls } = await preToolUse(BRAIN_UPDATE_TOOL, input);

    expect(permissionCalls).toEqual([
      {
        toolUseId: "update-1",
        toolName: BRAIN_UPDATE_TOOL,
        input: { path: "notes/thing.md", status: "archived" },
        description:
          'Setting status to "archived" removes this document from search, briefings and context assembly.',
        // "command", never "tool": the host must not remember this as
        // "always allow brain_update" — that would reopen the hole for good.
        kind: "command",
      },
    ]);
    expect(output).toEqual({ continue: true });
  });

  test("asks even when it is one field among several", async () => {
    const { permissionCalls } = await preToolUse(BRAIN_UPDATE_TOOL, {
      path: "notes/thing.md",
      summary: "Wrapped up",
      status: "archived",
      append_content: "Closing note.",
    });
    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0].kind).toBe("command");
  });

  test("a denial becomes a PreToolUse denial, so the write never runs", async () => {
    const { output, permissionCalls } = await preToolUse(
      BRAIN_UPDATE_TOOL,
      { path: "notes/thing.md", status: "archived" },
      { behavior: "deny", message: "Keep it visible." }
    );

    expect(permissionCalls).toHaveLength(1);
    expect(output).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Keep it visible.",
      },
    });
  });
});

describe("every other update stays silent", () => {
  test("an update that does not touch status raises nothing", async () => {
    const { output, permissionCalls } = await preToolUse(BRAIN_UPDATE_TOOL, {
      path: "notes/thing.md",
      summary: "A new one-liner",
      append_content: "More detail.",
      tags: "alpha,beta",
    });
    expect(permissionCalls).toEqual([]);
    expect(output).toEqual({ continue: true });
  });

  test("status: active and status: draft raise nothing", async () => {
    for (const status of ["active", "draft"]) {
      const { output, permissionCalls } = await preToolUse(BRAIN_UPDATE_TOOL, {
        path: "notes/thing.md",
        status,
      });
      expect(permissionCalls, `status: ${status} must not ask`).toEqual([]);
      expect(output).toEqual({ continue: true });
    }
  });

  test("un-archiving is not gated — it only ever makes a document visible", async () => {
    const { permissionCalls } = await preToolUse(BRAIN_UPDATE_TOOL, {
      path: "projects/archive/old.md",
      status: "active",
    });
    expect(permissionCalls).toEqual([]);
  });

  test("the word archived elsewhere in the input is not enough", async () => {
    const { permissionCalls } = await preToolUse(BRAIN_UPDATE_TOOL, {
      path: "notes/thing.md",
      summary: "Notes on how archived documents behave",
      append_content: "status: archived is a frontmatter field.",
    });
    expect(permissionCalls).toEqual([]);
  });

  test("another mutating tool carrying a status field is untouched", async () => {
    // brain_add has no status in its schema; a stray one must not turn a
    // document creation into a card.
    const { permissionCalls } = await preToolUse("mcp__brain__brain_add", {
      content: "New note",
      status: "archived",
    });
    expect(permissionCalls).toEqual([]);
  });
});
