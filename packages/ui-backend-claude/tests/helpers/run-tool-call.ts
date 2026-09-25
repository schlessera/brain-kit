import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";

/** What one tool call did, as the runtime would have resolved it. */
export interface ToolCallOutcome {
  /** Did the tool actually run? */
  executed: boolean;
  /** The input it would have run with (rewrites applied). */
  input: Record<string, unknown>;
  /** Was a permission decision taken, rather than skipped? */
  decided: boolean;
  /** The deny message the model was handed, when it was denied. */
  message: string | undefined;
}

interface PreToolUseOutput {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
}

/**
 * Drive one tool call through the runtime's precedence as measured (#124,
 * #145), and re-measured against the runtime `MEASURED_RUNTIME` names by
 * scripts/measure-claude-runtime.ts.
 *
 * Every matching PreToolUse hook runs in parallel, each on the ORIGINAL
 * input, and all of them finish before anything is decided
 * ("parallel-rewrites-last-wins"). The `updatedInput` that applies is the one
 * from the hook that FINISHED last, whatever the registration order. Their
 * decisions then combine: any `deny` blocks ("inprocess-deny-beats-settings-
 * allow" is the measured safe direction); an `allow` executes and skips the
 * callback; an `ask` forces the callback. After the hooks come the turn's
 * `allowedTools` and the runtime's own auto-approval, then `canUseTool` on
 * whatever input survived the hooks.
 *
 * One in-process `allow` alongside one in-process `ask` has NOT been
 * measured, so this throws rather than choosing a precedence: a test that
 * reaches it needs a measurement first (#231).
 *
 * `runtimeAutoApproves` stands in for the permission opinions the runtime
 * holds before the callback is reached — its safe-command classifier, a
 * built-in tool's own check, an allow rule in the project settings. Modelling
 * it is the point: without it a test would "prove" enforcement by assuming the
 * very fallthrough that does not always happen.
 */
export async function runToolCall(
  options: Options,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  runtimeAutoApproves = false
): Promise<ToolCallOutcome> {
  const hooks = (options.hooks?.PreToolUse ?? [])
    .filter((group) => !group.matcher || new RegExp(group.matcher).test(toolName))
    .flatMap((group) => group.hooks);
  // Recorded as each hook resolves, so the order is completion order.
  const finished: PreToolUseOutput[] = [];
  await Promise.all(
    hooks.map(async (hook) => {
      const output = (await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: input,
          tool_use_id: toolUseId,
        } as never,
        toolUseId,
        { signal: new AbortController().signal }
      )) as { hookSpecificOutput?: PreToolUseOutput } | undefined;
      finished.push(output?.hookSpecificOutput ?? {});
    })
  );

  const current =
    finished.findLast((out) => out.updatedInput !== undefined)?.updatedInput ?? input;
  const denied = finished.find((out) => out.permissionDecision === "deny");
  if (denied) {
    return { executed: false, input: current, decided: true, message: denied.permissionDecisionReason };
  }
  const allowed = finished.some((out) => out.permissionDecision === "allow");
  const asked = finished.some((out) => out.permissionDecision === "ask");
  if (allowed && asked) {
    throw new Error(
      `${toolName}: one hook answered "allow" and another "ask"; that precedence is unmeasured (#231)`
    );
  }
  if (allowed) return { executed: true, input: current, decided: false, message: undefined };
  if (!asked && ((options.allowedTools ?? []).includes(toolName) || runtimeAutoApproves)) {
    return { executed: true, input: current, decided: false, message: undefined };
  }
  const decision = (await options.canUseTool!(toolName, current, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
  } as never)) as PermissionDecision;
  return decision.behavior === "allow"
    ? { executed: true, input: decision.updatedInput ?? current, decided: true, message: undefined }
    : { executed: false, input: current, decided: true, message: decision.message };
}
