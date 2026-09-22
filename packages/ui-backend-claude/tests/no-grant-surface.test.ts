/**
 * A turn with no grant surface denies rather than asks (#110).
 *
 * `enforceAllowedTools` (#124/#141) removed the ways a tool could be admitted
 * without a decision being taken. What it did NOT change is what happens once
 * the decision is forced: the enforcement hook answers `ask`, so an off-posture
 * tool parks an approval card. In a turn nobody is looking at — a spoken one,
 * an unattended one — that card is one nobody can answer, and it parks until
 * the turn budget expires. `noGrantSurface` says so, and the request is then
 * refused where it is raised.
 *
 * The `ask` stays. It is the one answer that beats the three permission
 * opinions the runtime holds before `canUseTool` (a safe-command classifier, a
 * built-in tool's own check, a project-settings PreToolUse hook returning
 * allow), all measured against Claude Code 2.1.280 /
 * @anthropic-ai/claude-agent-sdk 0.3.278. What changes is the decision the
 * `ask` forces, not the `ask`.
 *
 * Both request kinds are asserted separately, because they travel different
 * paths and a rule written only for `canUseTool` misses the one that matters:
 * Bash is auto-allowed, so a destructive command raises its `command` request
 * from the PreToolUse `mutatingHook`, before any tool grant is considered.
 */

import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendActivityEvent,
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { MASK_TOOL_NAME } from "../src/mask-tool";
import { BRAIN_UPDATE_TOOL } from "../src/tool-policy";

/** What one tool call did, as the runtime would have resolved it. */
interface ToolCallOutcome {
  executed: boolean;
  /** The deny message the model was handed, when it was denied. */
  message: string | undefined;
  /** Was a permission decision taken, rather than skipped? */
  decided: boolean;
}

/**
 * Drive one tool call through the runtime's precedence as measured for #124:
 * every matching PreToolUse hook fires and their outputs combine (a `deny`
 * blocks, an `allow` executes and skips the callback, an `ask` forces the
 * callback), then the turn's `allowedTools` and the runtime's own
 * auto-approval, then `canUseTool`.
 *
 * `runtimeAutoApproves` stands in for the opinions the runtime holds before
 * the callback. Modelling it is the point: without it a test would "prove"
 * enforcement by assuming a fallthrough that does not always happen.
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
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: input,
          tool_use_id: toolUseId,
        } as never,
        toolUseId,
        { signal: new AbortController().signal }
      )) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      const out = output?.hookSpecificOutput;
      if (out?.permissionDecision === "deny") {
        return { executed: false, message: out.permissionDecisionReason, decided: true };
      }
      if (out?.permissionDecision === "allow") {
        return { executed: true, message: undefined, decided: false };
      }
      if (out?.permissionDecision === "ask") asked = true;
    }
  }
  if (!asked && ((options.allowedTools ?? []).includes(toolName) || runtimeAutoApproves)) {
    return { executed: true, message: undefined, decided: false };
  }
  const decision = (await options.canUseTool!(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
  } as never)) as PermissionDecision;
  return decision.behavior === "allow"
    ? { executed: true, message: undefined, decided: true }
    : { executed: false, message: decision.message, decided: true };
}

interface Harness {
  options: Options;
  requests: PermissionRequest[];
  /** Frames the host put on the wire, as the real bridge would have. */
  frames: ServerMessage[];
  activity: BackendActivityEvent[];
}

/**
 * Start one turn and capture the SDK options it built. `requestPermission`
 * mirrors what the real host does first (`packages/ui-server/src/ws/bridge.ts`):
 * it puts a `tool_approval_request` frame on the wire and then waits. That is
 * what makes "no frame was emitted" an assertion about the card rather than
 * about this stub — a request that reaches the bridge IS a card on the Actions
 * page.
 */
async function startTurn(setup: {
  allowedTools: string[];
  enforceAllowedTools?: boolean;
  noGrantSurface?: boolean;
  withMaskHandler?: boolean;
  decision?: PermissionDecision;
}): Promise<Harness> {
  const requests: PermissionRequest[] = [];
  const frames: ServerMessage[] = [];
  const activity: BackendActivityEvent[] = [];
  const bridge: BackendBridge = {
    emit: (msg) => frames.push(msg),
    requestPermission: async (request) => {
      requests.push(request);
      frames.push({
        type: "tool_approval_request",
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        description: request.description,
        ...(request.kind ? { kind: request.kind } : {}),
      });
      return setup.decision ?? { behavior: "deny", message: "Not approved." };
    },
    activity: (event) => activity.push(event),
    ...(setup.withMaskHandler
      ? { requestMask: async () => new Uint8Array() }
      : {}),
  };
  let captured: Options | undefined;
  const queryFn = ((params: { options?: Options }) => {
    captured = params.options!;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "result",
        subtype: "success",
        session_id: "s1",
        total_cost_usd: 0,
        duration_ms: 1,
        num_turns: 1,
      };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({
    brainPath: "/brain",
    queryFn,
    allowedTools: setup.allowedTools,
    log: () => {},
  });
  await backend.startTurn({
    prompt: "speak to me",
    signal: new AbortController().signal,
    bridge,
    ...(setup.enforceAllowedTools ? { enforceAllowedTools: true } : {}),
    ...(setup.noGrantSurface ? { noGrantSurface: true } : {}),
  });
  return { options: captured!, requests, frames, activity };
}

const approvalFrames = (harness: Harness) =>
  harness.frames.filter((frame) => frame.type === "tool_approval_request");

/**
 * The model has to act on this message and a listener has to hear it read out,
 * so both are checked rather than eyeballed: it names the tool, and it is
 * whole sentences rather than a fragment.
 */
function expectSpeakableDenial(message: string | undefined, toolName: string): void {
  expect(message).toBeString();
  expect(message).toContain(toolName);
  expect(message![0]).toBe(message![0]!.toUpperCase());
  expect(message!.trimEnd().endsWith(".")).toBe(true);
  // A complete sentence, not a label: the shortest phrasing this rules out is
  // the tool name on its own, which says nothing a person can act on.
  expect(message!.trim().split(/\s+/).length).toBeGreaterThan(8);
}

const WITHOUT_SHELL = ["Read", "Grep", "Glob"];
const WITH_SHELL = ["Read", "Grep", "Glob", "Bash"];
const DESTRUCTIVE = { command: "rm -rf /brain/notes/old" };

describe("a turn with no grant surface, kind tool", () => {
  test("a tool outside the enforced allowlist is denied with no card raised", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL,
      enforceAllowedTools: true,
      noGrantSurface: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "mcp__external__publish",
      { id: 7 },
      "publish-no-surface",
      true // the runtime would have waved it through; the `ask` still forces the callback
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.decided).toBe(true);
    // Nothing was put to the host, so nothing was parked on the Actions page.
    expect(harness.requests).toHaveLength(0);
    expect(approvalFrames(harness)).toHaveLength(0);
    expectSpeakableDenial(outcome.message, "mcp__external__publish");
  });

  test("the denial is reported for the activity record, as a denial", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL,
      enforceAllowedTools: true,
      noGrantSurface: true,
    });

    await runToolCall(
      harness.options,
      "mcp__external__publish",
      { id: 7 },
      "publish-recorded"
    );

    expect(harness.activity).toEqual([
      {
        kind: "permission_denied",
        toolUseId: "publish-recorded",
        requestKind: "tool",
        reason: expect.any(String),
      },
    ]);
  });
});

describe("a turn with no grant surface, kind command", () => {
  test("a destructive Bash command is denied with no card raised", async () => {
    // Bash IS on this allowlist, so the enforcement hook never fires and
    // canUseTool is never consulted: the request comes from the PreToolUse
    // mutatingHook, which is the path a rule written for canUseTool misses.
    const harness = await startTurn({
      allowedTools: WITH_SHELL,
      enforceAllowedTools: true,
      noGrantSurface: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      DESTRUCTIVE,
      "bash-no-surface"
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.decided).toBe(true);
    expect(harness.requests).toHaveLength(0);
    expect(approvalFrames(harness)).toHaveLength(0);
    expectSpeakableDenial(outcome.message, "Bash");
    expect(harness.activity).toEqual([
      {
        kind: "permission_denied",
        toolUseId: "bash-no-surface",
        requestKind: "command",
        reason: expect.any(String),
      },
    ]);
  });

  test("an archiving brain_update is denied with no card raised", async () => {
    // The second way a `command` request arises, and it comes from the same
    // hook: brain_update with status "archived" is a visibility change on an
    // auto-allowed tool, so canUseTool never sees it either.
    const harness = await startTurn({
      allowedTools: [...WITH_SHELL, BRAIN_UPDATE_TOOL],
      enforceAllowedTools: true,
      noGrantSurface: true,
    });

    const outcome = await runToolCall(
      harness.options,
      BRAIN_UPDATE_TOOL,
      { path: "notes/a.md", status: "archived" },
      "update-no-surface"
    );

    expect(outcome.executed).toBe(false);
    expect(harness.requests).toHaveLength(0);
    expect(approvalFrames(harness)).toHaveLength(0);
    expectSpeakableDenial(outcome.message, BRAIN_UPDATE_TOOL);
    expect(harness.activity[0]).toMatchObject({
      kind: "permission_denied",
      requestKind: "command",
    });
  });

  test("a command that matches nothing still runs", async () => {
    // The seatbelt is what is refused, not the shell: a turn with no grant
    // surface that never triggers a confirmation is not degraded by this.
    const harness = await startTurn({
      allowedTools: WITH_SHELL,
      enforceAllowedTools: true,
      noGrantSurface: true,
    });

    const outcome = await runToolCall(
      harness.options,
      "Bash",
      { command: "git status" },
      "bash-harmless"
    );

    expect(outcome.executed).toBe(true);
    expect(harness.requests).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
  });
});

describe("the capability that needs eyes", () => {
  test("the mask editor is not appended to a turn with no grant surface", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL,
      enforceAllowedTools: true,
      noGrantSurface: true,
      withMaskHandler: true,
    });

    // Asserted on the resolved allowlist, not on a decision: the bug is the
    // append, which puts the tool INSIDE the enforced allowlist whatever the
    // posture declared.
    expect(harness.options.allowedTools).not.toContain(MASK_TOOL_NAME);
    // And it is withheld, not merely un-allowlisted: nothing tells the model
    // it has an editor it cannot open.
    expect(JSON.stringify(harness.options.systemPrompt)).not.toContain(MASK_TOOL_NAME);
  });

  test("the same bridge hands it to a turn that has a grant surface", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL,
      enforceAllowedTools: true,
      withMaskHandler: true,
    });

    expect(harness.options.allowedTools).toContain(MASK_TOOL_NAME);
  });
});

describe("turns that did not declare it", () => {
  test("an enforced turn still raises a card, and it can still be answered", async () => {
    const harness = await startTurn({
      allowedTools: WITHOUT_SHELL,
      enforceAllowedTools: true,
      decision: { behavior: "allow" },
    });

    const outcome = await runToolCall(
      harness.options,
      "mcp__external__publish",
      { id: 7 },
      "publish-enforced",
      true
    );

    expect(outcome.executed).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(approvalFrames(harness)).toHaveLength(1);
    expect(harness.activity).toHaveLength(0);
  });

  test("an enforced turn's destructive command still raises its command card", async () => {
    const harness = await startTurn({
      allowedTools: WITH_SHELL,
      enforceAllowedTools: true,
      decision: { behavior: "allow" },
    });

    const outcome = await runToolCall(harness.options, "Bash", DESTRUCTIVE, "bash-enforced");

    expect(outcome.executed).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.kind).toBe("command");
    expect(approvalFrames(harness)).toHaveLength(1);
  });

  test("a turn that declares neither is unchanged", async () => {
    const harness = await startTurn({
      allowedTools: WITH_SHELL,
      decision: { behavior: "allow" },
    });

    const outcome = await runToolCall(harness.options, "Bash", DESTRUCTIVE, "bash-default");

    expect(outcome.executed).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(approvalFrames(harness)).toHaveLength(1);
    expect(harness.activity).toHaveLength(0);
  });
});
