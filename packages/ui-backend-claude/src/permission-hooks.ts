import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import {
  createToolPermissionRequest,
  decideToolPermission,
  requestToolPermission,
} from "@schlessera/brain-ui-sdk/server";

import {
  lockKeyForTool,
  MUTATING_TOOL_MATCHER,
  MUTATING_TOOLS,
} from "./tool-policy.js";
import type { TurnLockBinding } from "./turn-lock.js";
import { createAgentHook, createRtkHook } from "./input-rewrite-hooks.js";
import type { BackendLogFn } from "./options.js";

const NO_ALLOWED_TOOLS: ReadonlySet<string> = new Set();

/** Structural translation of a bridge PermissionDecision into the SDK's PermissionResult. */
function toPermissionResult(
  decision: Awaited<ReturnType<typeof requestToolPermission>>
): PermissionResult {
  if (decision.behavior === "allow") {
    // Omit updatedInput when the user approved unchanged so the SDK runs the
    // tool with its original input. Claude requires structural replacement;
    // pi's binding mutates in place.
    return decision.updatedInput !== undefined
      ? { behavior: "allow", updatedInput: decision.updatedInput }
      : { behavior: "allow" };
  }
  return { behavior: "deny", message: decision.message };
}

export function createPermissionWiring(options: {
  req: StartTurnRequest;
  allowedTools: readonly string[];
  confirmPatterns: readonly RegExp[];
  brainPath: string;
  turnLock: TurnLockBinding;
  /** The filtered environment this turn's subprocesses run with. */
  childEnv: NodeJS.ProcessEnv;
  /** Where a withheld re-admission is recorded. */
  log: BackendLogFn;
}): Pick<Options, "canUseTool" | "hooks"> {
  const { req, allowedTools, confirmPatterns, brainPath, turnLock, childEnv, log } = options;
  const allowed = new Set(allowedTools);
  // The turn declared its allowlist is a boundary, not merely an auto-allow
  // list (StartTurnRequest.enforceAllowedTools). Everything below that would
  // otherwise admit a tool WITHOUT a permission decision is evaluated against
  // this first — the two rewrite hooks here, and the host's remembered-grant
  // lookup, which is told through the request rather than guessed at.
  const enforced = req.enforceAllowedTools === true;
  /** A tool the enforced allowlist left out: no shortcut may admit it. */
  const outsideEnforcedAllowlist = (toolName: string): boolean =>
    enforced && !allowed.has(toolName);
  const withheld = (toolName: string): void => {
    log("warn", "allowlist enforced: withheld an input-rewrite auto-allow", {
      "tool.name": toolName,
    });
  };
  // PreToolUse historically checks confirm patterns even when a deployment
  // removes Bash from its allowlist (canUseTool then performs the tool grant).
  // Model that hook path as command-allowed to preserve the two runtime gates.
  const commandAllowed = new Set(allowed);
  commandAllowed.add("Bash");

  const canUseTool: NonNullable<Options["canUseTool"]> = async (
    toolName,
    input,
    opts
  ) => {
    // The PreToolUse hook below may already hold the write lock for this tool
    // use (it fires before permission evaluation). Don't keep the lock across
    // the (possibly long) approval wait — release it now and re-acquire only
    // once the tool is actually approved.
    turnLock.releaseForTool(opts.toolUseID);
    const approval = decideToolPermission({
      toolName,
      shellToolName: "Bash",
      input,
      // Reaching canUseTool is itself Claude's signal that this call was not
      // auto-allowed. Model that runtime fact explicitly so direct callback
      // invocation has the same behaviour as the SDK path.
      allowedTools: NO_ALLOWED_TOOLS,
      confirmPatterns,
    });
    // The empty runtime allowlist above always produces a tool approval.
    if (!approval) throw new Error("unreachable permission decision");
    const request = createToolPermissionRequest({
      toolUseId: opts.toolUseID,
      toolName,
      input,
      description: opts.description,
      approval,
      // The host answers this one on its own merits: reaching here means the
      // turn's allowlist left the tool out, and under enforcement a grant
      // remembered on a wider posture is not an answer to it.
      outsideEnforcedAllowlist: outsideEnforcedAllowlist(toolName),
    });
    const decision = await requestToolPermission(req.bridge, request);
    // A mutating tool runs inside this subprocess the moment we return
    // "allow", so take its lock BEFORE allowing and hold it until the tool's
    // result frame is observed (see the stream loop) or the turn ends. Denials
    // and lock-free tools take nothing. The approved input is what will
    // execute, so the key is computed from it.
    if (decision.behavior === "allow" && MUTATING_TOOLS.has(toolName)) {
      const effectiveInput = decision.updatedInput ?? input;
      const acquired = await turnLock.acquireForTool(
        opts.toolUseID,
        lockKeyForTool(toolName, effectiveInput, brainPath)
      );
      if (!acquired.ok) return { behavior: "deny", message: acquired.reason };
    }
    return toPermissionResult(decision);
  };

  // The write lock CANNOT live in canUseTool alone: the SDK auto-allows every
  // tool listed in `allowedTools` without invoking the callback (it warns
  // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and the default allowlist contains all
  // mutating tools. PreToolUse fires before every tool execution — auto-allowed
  // or approved — and the SDK awaits it, so acquiring here serializes writes
  // across turns no matter which permission path admitted the tool.
  const mutatingHook: HookCallback = async (hookInput) => {
    if (
      hookInput.hook_event_name !== "PreToolUse" ||
      !MUTATING_TOOLS.has(hookInput.tool_name)
    ) {
      return { continue: true };
    }

    // Confirmation for a Bash command that matches a configured pattern. It
    // happens HERE, not in canUseTool, because Bash is auto-allowed, so
    // canUseTool is never consulted for it. The PreToolUse hook is the runtime
    // binding for the shared command decision.
    //
    // Asked BEFORE the lock is taken — a user deliberating for ten minutes
    // must not hold the write lock against every other session that whole time.
    if (hookInput.tool_name === "Bash") {
      const approval = decideToolPermission({
        toolName: hookInput.tool_name,
        shellToolName: "Bash",
        input: hookInput.tool_input,
        allowedTools: commandAllowed,
        confirmPatterns,
      });
      if (approval?.kind === "command") {
        // A per-use confirmation, not a tool grant — the host must never
        // remember it as "always allow Bash".
        const request = createToolPermissionRequest({
          toolUseId: hookInput.tool_use_id,
          toolName: "Bash",
          input: hookInput.tool_input as Record<string, unknown>,
          description: approval.reason,
          approval,
        });
        const decision = await requestToolPermission(req.bridge, request);
        if (decision.behavior !== "allow") {
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.message ?? "Denied by the user.",
            },
          };
        }
      }
    }

    const acquired = await turnLock.acquireForTool(
      hookInput.tool_use_id,
      lockKeyForTool(hookInput.tool_name, hookInput.tool_input, brainPath)
    );
    if (!acquired.ok) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: acquired.reason,
        },
      };
    }
    return { continue: true };
  };

  const agentHook = createAgentHook({
    mayGrant: !outsideEnforcedAllowlist("Agent"),
    onGrantWithheld: withheld,
  });
  const rtkHook = createRtkHook(childEnv, {
    mayGrant: !outsideEnforcedAllowlist("Bash"),
    onGrantWithheld: withheld,
  });

  return {
    canUseTool,
    hooks: {
      PreToolUse: [
        { matcher: MUTATING_TOOL_MATCHER, hooks: [mutatingHook] },
        { matcher: "^Agent$", hooks: [agentHook] },
        { matcher: "^Bash$", hooks: [rtkHook] },
      ],
      PermissionDenied: [
        {
          // A deny decided outside canUseTool (settings deny rules, other
          // hooks) must still free a lock the PreToolUse hook took; our own
          // canUseTool deny releases up front.
          hooks: [
            async (_hookInput, toolUseID) => {
              if (toolUseID) turnLock.releaseForTool(toolUseID);
              return { continue: true };
            },
          ],
        },
      ],
    },
  };
}
