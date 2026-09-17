import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export function createAgentHook(): HookCallback {
  // Background subagents cannot outlive the turn: each turn is its own
  // `query()` subprocess, and the SDK's Agent tool BACKGROUNDS agents by
  // default — so left alone, a fan-out dies at turn end with nothing written
  // (observed: two waves, 23 dead agents). Rewriting the input to foreground
  // is the only fix that also covers the default case; a deny would break
  // every Agent call.
  return async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "Agent") {
      return { continue: true };
    }
    const input = hookInput.tool_input as Record<string, unknown>;
    if (input.isolation === "remote") {
      // A remote agent survives the subprocess but its results land in a cloud
      // session this host never reads.
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
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        // "allow" is required for updatedInput to take effect. Agent is
        // auto-allowed by the default allowlist anyway; a deployment that
        // removes it from allowedTools should know this rewrite re-admits it.
        permissionDecision: "allow",
        updatedInput: { ...input, run_in_background: false },
        additionalContext:
          "This Agent call was rewritten to run_in_background: false. Each turn is its own process, so a background agent would be killed at turn end before its results could be read. Fan out with foreground agents and collect results within the turn.",
      },
    };
  };
}
