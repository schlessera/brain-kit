import type { HookCallback, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import {
  createToolPermissionRequest,
  decideToolPermission,
  requestToolPermission,
} from "@schlessera/brain-ui-sdk/server";

import {
  BRAIN_UPDATE_TOOL,
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

  // DO NOT WEAKEN THIS INTO A FALLTHROUGH. Withholding OUR shortcuts is not
  // enough: three things outside this file admit a tool before canUseTool is
  // reached, so "it is off the allowlist, the callback will catch it" is
  // false. Each was measured against Claude Code 2.1.280 / SDK 0.3.278 with a
  // real query() and an EMPTY allowedTools; what is NOT a bypass is recorded
  // too, because guessing at this once already put a wrong mechanism here.
  //
  // 1. The runtime's safe-command classifier, on the command's SHAPE. `echo
  //    hi` ran and the callback was never consulted; `touch <path>`, same
  //    harness, went through it. Picking the wrong probe command hides this.
  // 2. A built-in tool permitted without the callback at all. `ToolSearch`
  //    executed twice with nothing on the allowlist and no hook registered.
  // 3. A PreToolUse hook in the PROJECT SETTINGS this backend loads
  //    (`settingSources: ["project"]` in sdk-options.ts) returning
  //    `permissionDecision: "allow"`. That file lives in the brain repo,
  //    which is the turn's cwd, and Write/Edit are on the default allowlist —
  //    so a wide-posture turn can write it and re-widen every later narrow
  //    one. Enforcement therefore cannot be a property of configuration.
  //    It is a GRANTING vector only: an in-process PreToolUse deny still wins
  //    over it, measured, so a hook that refuses cannot be talked out of it.
  //
  // What does NOT skip the callback, in those same project settings:
  // `permissions.allow` rules, and `permissions.defaultMode:
  // "bypassPermissions"`. Both were tried; canUseTool was still consulted.
  //
  // An explicit "ask" beats all three — measured for each, and for the
  // settings hook with a canUseTool deny then holding — and it leaves another
  // hook's updatedInput intact, so the rewrites still reach the decision.
  // Registered only under the declaration, so nothing moves for a turn that
  // declares nothing.
  const enforcementHook: HookCallback = async (hookInput) => {
    if (
      hookInput.hook_event_name !== "PreToolUse" ||
      allowed.has(hookInput.tool_name)
    ) {
      return { continue: true };
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Tool "${hookInput.tool_name}" is outside this turn's enforced allowlist, so it cannot run until someone decides it.`,
      },
    };
  };
  // PreToolUse historically checks confirm patterns even when a deployment
  // removes Bash from its allowlist (canUseTool then performs the tool grant).
  // Model that hook path as command-allowed to preserve the two runtime gates.
  //
  // BRAIN_UPDATE_TOOL is here for the same reason, and the reason is sharper:
  // the fallback card from canUseTool is kind "tool", which a remembered
  // "always allow" answers without showing anything (ws/bridge.ts refuses to
  // do that only for kind "command"). Without this line, a deployment that
  // NARROWED its allowlist would lose the archiving confirmation entirely
  // after one such grant — the tool removed from the allowlist behaving more
  // permissively than the tool left on it, which is the shape of #124.
  const commandAllowed = new Set(allowed);
  commandAllowed.add("Bash");
  commandAllowed.add(BRAIN_UPDATE_TOOL);

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

    // Confirmation for an auto-allowed call that is destructive anyway: a Bash
    // command matching a configured pattern, or a brain_update that archives.
    // It happens HERE, not in canUseTool, because both tools are auto-allowed,
    // so canUseTool is never consulted for them — this hook is the only place
    // such a call is seen before it runs. The decision itself is the shared
    // one; this is just its runtime binding.
    //
    // Allowlisting is not the only reason it belongs here. This backend loads
    // the brain repo's project settings (sdk-options.ts:89), and a hook
    // declared in those can answer a call before canUseTool is reached at all
    // — #124 has the measurements. This hook fires either way. None of that
    // makes the confirmation containment: an agent that can write the repo
    // can always reach the same effect another way, which is the posture
    // DEFAULT_CONFIRM_BASH_PATTERNS states in full.
    //
    // Any OTHER call that is not auto-allowed yields kind "tool" here and is
    // left alone: canUseTool raises its grantable card, and asking twice for
    // one tool use would be worse than either card on its own. Bash and
    // brain_update are the two exceptions above, deliberately: for them a
    // narrowed allowlist gets both gates, because the grantable card alone is
    // rememberable and the per-use one is not.
    //
    // Asked BEFORE the lock is taken — a user deliberating for ten minutes
    // must not hold the write lock against every other session that whole time.
    const approval = decideToolPermission({
      toolName: hookInput.tool_name,
      shellToolName: "Bash",
      updateToolName: BRAIN_UPDATE_TOOL,
      input: hookInput.tool_input,
      allowedTools: commandAllowed,
      confirmPatterns,
    });
    if (approval?.kind === "command") {
      // A per-use confirmation, not a tool grant — the host must never
      // remember it as "always allow Bash" or "always allow brain_update".
      const request = createToolPermissionRequest({
        toolUseId: hookInput.tool_use_id,
        toolName: hookInput.tool_name,
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
      if (decision.updatedInput !== undefined) {
        // The host approved an EDITED call, and this hook cannot apply the
        // edit: the SDK honours `updatedInput` only alongside
        // `permissionDecision: "allow"`, and emitting that here would also
        // re-admit a tool a deployment deliberately removed from
        // `allowedTools` — the re-admission hazard the rewrite hooks already
        // carry (see input-rewrite-hooks.ts). Proceeding would instead run
        // the ORIGINAL input, i.e. archive a document the host just said to
        // leave alone. Refuse, which is both the safe direction and a visible
        // one; canUseTool remains the path that applies an edit.
        // Recorded for the same reason a withheld re-admission is: a gate
        // that stops applying must be visible, not silently absent.
        log("warn", "confirmation approved with an edit this hook cannot apply; refused", {
          "tool.name": hookInput.tool_name,
        });
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "This confirmation was approved with an edited input, which cannot be applied here. Re-issue the call with the input you want.",
          },
        };
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
        // First, and over every tool (no matcher): nothing the runtime would
        // otherwise wave through gets to skip the decision, including a
        // subagent's own tool calls, which surface here under their own names.
        // First rather than last because that is the order the merge was
        // measured in. Note that tests index this array positionally, so a
        // test for an enforced turn must match on the matcher, not the index.
        ...(enforced ? [{ hooks: [enforcementHook] }] : []),
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
