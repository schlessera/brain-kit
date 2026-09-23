/**
 * The voice posture as a named allowlist (#111).
 *
 * `docs/decisions/voice-permission.md` ("The voice posture") fixes the tool set a
 * spoken turn runs under, with a reason per entry. These tests pin that
 * membership exactly, so a tool added to `DEFAULT_ALLOWED_TOOLS` cannot
 * silently widen it. They also drive one turn under the posture end to end.
 * That turn declares `enforceAllowedTools` and `noGrantSurface`: #173 refuses
 * the second without the first, and the voice posture is the case that rule
 * exists for.
 */

import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendActivityEvent,
  PermissionDecision,
  PermissionRequest,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { MASK_TOOL_NAME } from "../src/mask-tool";
import * as policy from "../src/tool-policy";

/**
 * Read off the module namespace so that the tree before #111 fails an
 * assertion, not the import.
 */
const VOICE = (policy as { VOICE_ALLOWED_TOOLS?: readonly string[] }).VOICE_ALLOWED_TOOLS;

/** The decision record's "Allowed" table, row by row. */
const RECORD_ALLOWED = [
  "mcp__brain__brain_search",
  "mcp__brain__brain_context",
  "mcp__brain__brain_read",
  "mcp__brain__brain_list",
  "mcp__brain__brain_graph",
  "mcp__brain__brain_add",
  "mcp__brain__brain_update",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "mcp__brain-ui__ask_user",
  "mcp__brain-ui__get_current_location",
  "mcp__brain-ui__query_activity",
  "mcp__brain-ui__show_block",
];

/** The decision record's "Excluded" table. */
const RECORD_EXCLUDED = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "Agent",
  "Skill",
  "LSP",
  "mcp__brain__brain_archive",
  "mcp__brain-ui__request_image_mask",
];

describe("VOICE_ALLOWED_TOOLS", () => {
  test("is exactly the decision record's allowed table", () => {
    expect([...(VOICE ?? [])].sort()).toEqual([...RECORD_ALLOWED].sort());
    // No duplicates hiding behind the sort.
    expect(new Set(VOICE ?? []).size).toBe(VOICE?.length ?? -1);
  });

  test("does not contain Bash", () => {
    // 192 of 192 measured approvals came from it, and its payload cannot be
    // read aloud. The whole cost of the voice posture, taken on purpose.
    expect(VOICE).toBeDefined();
    expect(VOICE).not.toContain("Bash");
  });

  test("contains nothing from the excluded table", () => {
    expect(VOICE).toBeDefined();
    for (const tool of RECORD_EXCLUDED) expect(VOICE, tool).not.toContain(tool);
  });

  test("is not derived from the default list: it holds nothing the record did not name", () => {
    // Every default tool is either in the voice set or excluded by name. A
    // tool added to the default list later fails here until someone decides
    // which table it belongs in.
    expect(VOICE).toBeDefined();
    for (const tool of policy.DEFAULT_ALLOWED_TOOLS) {
      expect(
        RECORD_ALLOWED.includes(tool) || RECORD_EXCLUDED.includes(tool),
        `${tool} is in DEFAULT_ALLOWED_TOOLS but in neither of the record's tables`
      ).toBe(true);
    }
  });
});

interface ToolCallOutcome {
  executed: boolean;
  message: string | undefined;
}

/**
 * One tool call through the runtime's precedence as measured for #124/#154:
 * every matching PreToolUse hook (a `deny` blocks, an `allow` executes, an
 * `ask` forces the callback), then `allowedTools` and the runtime's own
 * auto-approval, then `canUseTool`. `runtimeAutoApproves` stands in for the
 * runtime's own opinions before the callback: the enforcement hook's `ask`
 * must beat them.
 */
async function runToolCall(
  options: Options,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  runtimeAutoApproves = false
): Promise<ToolCallOutcome> {
  let asked = false;
  for (const group of options.hooks?.PreToolUse ?? []) {
    if (group.matcher && !new RegExp(group.matcher).test(toolName)) continue;
    for (const hook of group.hooks) {
      const output = (await hook(
        { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, tool_use_id: toolUseId } as never,
        toolUseId,
        { signal: new AbortController().signal }
      )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      const out = output?.hookSpecificOutput;
      if (out?.permissionDecision === "deny") return { executed: false, message: out.permissionDecisionReason };
      if (out?.permissionDecision === "allow") return { executed: true, message: undefined };
      if (out?.permissionDecision === "ask") asked = true;
    }
  }
  if (!asked && ((options.allowedTools ?? []).includes(toolName) || runtimeAutoApproves)) {
    return { executed: true, message: undefined };
  }
  const decision = (await options.canUseTool!(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
  } as never)) as PermissionDecision;
  return decision.behavior === "allow"
    ? { executed: true, message: undefined }
    : { executed: false, message: decision.message };
}

/**
 * Start one turn under the voice posture: the named allowlist, enforced, with
 * no grant surface. The bridge mirrors the real host: a permission request is a
 * `tool_approval_request` frame on the wire, which here nobody could answer.
 */
async function voiceTurn(): Promise<{
  options: Options;
  requests: PermissionRequest[];
  frames: ServerMessage[];
  activity: BackendActivityEvent[];
}> {
  const requests: PermissionRequest[] = [];
  const frames: ServerMessage[] = [];
  const activity: BackendActivityEvent[] = [];
  let captured: Options | undefined;
  const queryFn = ((params: { options?: Options }) => {
    captured = params.options!;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "voice" };
      yield { type: "result", subtype: "success", session_id: "voice", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({
    brainPath: "/brain",
    queryFn,
    ...(VOICE ? { allowedTools: [...VOICE] } : {}),
    log: () => {},
  });
  await backend.startTurn({
    prompt: "add this to my note about the garden",
    signal: new AbortController().signal,
    enforceAllowedTools: true,
    noGrantSurface: true,
    bridge: {
      emit: (msg) => frames.push(msg),
      requestPermission: async (request) => {
        requests.push(request);
        frames.push({
          type: "tool_approval_request",
          toolUseId: request.toolUseId,
          toolName: request.toolName,
          input: request.input,
          description: request.description,
        });
        return { behavior: "allow" };
      },
      activity: (event) => activity.push(event),
      requestMask: async () => new Uint8Array(),
    },
  });
  return { options: captured!, requests, frames, activity };
}

const approvalFrames = (frames: ServerMessage[]) =>
  frames.filter((frame) => frame.type === "tool_approval_request");

describe("a turn under the voice posture", () => {
  test("denies Bash without raising a card, even for a command the runtime would wave through", async () => {
    const turn = await voiceTurn();

    for (const [id, command, autoApproved] of [
      ["bash-harmless", "git status", true],
      ["bash-destructive", "rm -rf notes/old", false],
    ] as const) {
      const outcome = await runToolCall(turn.options, "Bash", { command }, id, autoApproved);
      expect(outcome.executed, command).toBe(false);
      expect(outcome.message, command).toContain("Bash");
    }
    expect(turn.requests).toHaveLength(0);
    expect(approvalFrames(turn.frames)).toHaveLength(0);
    expect(turn.activity.map((event) => event.kind)).toEqual([
      "permission_denied",
      "permission_denied",
    ]);
  });

  test("allows brain_add and brain_update in that same turn: read-mostly, not read-only", async () => {
    const turn = await voiceTurn();

    const add = await runToolCall(turn.options, "mcp__brain__brain_add", { type: "note", title: "Garden" }, "add-1");
    const update = await runToolCall(
      turn.options,
      "mcp__brain__brain_update",
      { path: "notes/garden.md", append_content: "Planted tomatoes." },
      "update-1"
    );
    const bash = await runToolCall(turn.options, "Bash", { command: "ls" }, "bash-1", true);

    expect(add.executed).toBe(true);
    expect(update.executed).toBe(true);
    expect(bash.executed).toBe(false);
    expect(turn.requests).toHaveLength(0);
    expect(approvalFrames(turn.frames)).toHaveLength(0);
  });

  test("an archiving brain_update is still denied, not granted by the posture", async () => {
    const turn = await voiceTurn();
    const outcome = await runToolCall(
      turn.options,
      "mcp__brain__brain_update",
      { path: "notes/garden.md", status: "archived" },
      "archive-1"
    );
    expect(outcome.executed).toBe(false);
    expect(approvalFrames(turn.frames)).toHaveLength(0);
  });

  test("the mask editor is not in the turn's allowlist, although the host offers it", async () => {
    const turn = await voiceTurn();
    expect(turn.options.allowedTools).not.toContain(MASK_TOOL_NAME);
  });
});
