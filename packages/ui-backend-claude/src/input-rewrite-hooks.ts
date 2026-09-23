import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { bashCommand, rtkRewriteCommand } from "@schlessera/brain-ui-sdk/server";

/**
 * What a rewrite hook is allowed to do for ONE tool.
 *
 * Both hooks exist to rewrite a tool's input, and both used to grant the call
 * as well — `permissionDecision: "allow"` was believed to be what makes
 * `updatedInput` take effect. It is not: a PreToolUse hook that returns
 * `updatedInput` and NO decision still rewrites the call, and the rewritten
 * input is what the permission path then sees (measured for #124, and
 * against the runtime MEASURED_RUNTIME names by
 * scripts/measure-claude-runtime.ts). The
 * grant was therefore a side effect, and under an enforced allowlist it is the
 * side effect that gets dropped — the rewrite, which is the point, stays.
 */
export interface RewriteHookOptions {
  /**
   * Whether this hook may grant the call outright. False when the turn
   * declared `enforceAllowedTools` and the tool is not on its allowlist: the
   * hook then rewrites without granting, and the call falls through to the
   * ordinary permission path instead of executing on the hook's say-so.
   * Default true — a turn that declares nothing behaves as it always has.
   */
  mayGrant?: boolean;
  /**
   * Called when a grant is withheld, so a shortcut that used to admit the
   * tool leaves a record instead of silently doing nothing.
   */
  onGrantWithheld?: (toolName: string) => void;
  /**
   * A call this names is not rewritten at all. The Bash hook uses it for a
   * command that raises a per-use confirmation: matching PreToolUse hooks run
   * in parallel, each sees the ORIGINAL input, and the `updatedInput` of
   * whichever finishes last is what executes (measured for #145, and against
   * MEASURED_RUNTIME by scripts/measure-claude-runtime.ts). A rewrite of the
   * original could therefore land over an approved edit of it.
   */
  leaveAlone?: (input: unknown) => boolean;
}

export function createAgentHook(options: RewriteHookOptions = {}): HookCallback {
  // Background subagents cannot outlive the turn: each turn is its own
  // `query()` subprocess, and the SDK's Agent tool BACKGROUNDS agents by
  // default — so left alone, a fan-out dies at turn end with nothing written
  // (observed: two waves, 23 dead agents). Rewriting the input to foreground
  // is the only fix that also covers the default case; a deny would break
  // every Agent call.
  const mayGrant = options.mayGrant ?? true;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "Agent") {
      return { continue: true };
    }
    const input = hookInput.tool_input as Record<string, unknown>;
    if (input.isolation === "remote") {
      // A remote agent survives the subprocess but its results land in a cloud
      // session this host never reads. A deny is a decision, so an enforced
      // allowlist has no quarrel with it.
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Remote agents are not collectable in this host: their results outlive the turn but nothing reads them back. Re-run this Agent call without isolation: \"remote\".",
        },
      };
    }
    if (input.run_in_background === false) return { continue: true };
    if (!mayGrant) options.onGrantWithheld?.("Agent");
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        // "allow" makes the SDK skip canUseTool entirely, which re-admits a
        // tool the turn's allowlist left out. Withheld under enforcement; the
        // rewrite below applies either way.
        ...(mayGrant ? { permissionDecision: "allow" as const } : {}),
        updatedInput: { ...input, run_in_background: false },
        additionalContext:
          "This Agent call was rewritten to run_in_background: false. Each turn is its own process, so a background agent would be killed at turn end before its results could be read. Fan out with foreground agents and collect results within the turn.",
      },
    };
  };
}

export function createRtkHook(
  childEnv: NodeJS.ProcessEnv,
  options: RewriteHookOptions = {}
): HookCallback {
  // rtk (token-optimizing CLI proxy) rewrite. Runs AFTER the mutating-tools
  // hook, so confirm patterns and lock classification see the command as the
  // model wrote it; the rewritten form (`rtk git status`) is what executes.
  // When the rtk binary is absent or declines, the command is untouched.
  const mayGrant = options.mayGrant ?? true;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "Bash") {
      return { continue: true };
    }
    const command = bashCommand(hookInput.tool_input);
    if (!command || options.leaveAlone?.(hookInput.tool_input)) return { continue: true };
    const rewritten = await rtkRewriteCommand(command, childEnv);
    if (rewritten === command) return { continue: true };
    if (!mayGrant) options.onGrantWithheld?.("Bash");
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        // Same as the Agent hook: the grant is the side effect, not the
        // point. Under enforcement the rewritten command still executes —
        // once something has actually decided it may.
        ...(mayGrant
          ? {
              permissionDecision: "allow" as const,
              permissionDecisionReason: "rtk auto-rewrite",
            }
          : {}),
        updatedInput: {
          ...(hookInput.tool_input as Record<string, unknown>),
          command: rewritten,
        },
      },
    };
  };
}
