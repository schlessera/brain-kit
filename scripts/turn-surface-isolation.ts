/** Uniform fixture-only denial layer for the private #587 research arms. */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { measurementIsolationHook, measurementPath, type MeasurementToolAccess } from "./measurement-isolation";
import type { SurfaceDecision } from "./turn-surface-overlap";

const READ_ONLY_CORE = ["brain_search", "brain_context", "brain_read", "brain_list", "brain_graph"];
export function routingMeasurementHook(root: string, knownSkills: readonly string[], decision: Promise<SurfaceDecision>, audit: MeasurementToolAccess[]): HookCallback {
  const filesystem = measurementIsolationHook(root, "mcp__brain-ui__show_block", audit);
  return async (input, toolUseId, options) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const data = input.tool_input as Record<string, unknown>;
    let admitted = false;
    if (input.tool_name === "ToolSearch") admitted = true;
    else if (input.tool_name === "Skill") {
      const selected = await decision;
      admitted = typeof data.skill === "string" && knownSkills.includes(data.skill)
        && (!selected.routed || selected.arm !== "hard-prune" || selected.skills.includes(data.skill));
    } else if (READ_ONLY_CORE.some(name => input.tool_name === `mcp__brain__${name}`)) {
      admitted = input.tool_name !== "mcp__brain__brain_read"
        || (typeof data.path === "string" && measurementPath(root, data.path) !== null);
    } else if (input.tool_name.startsWith("mcp__brain-ui__") && input.tool_name !== "mcp__brain-ui__request_image_mask") admitted = true;
    if (admitted) {
      audit.push({ tool: input.tool_name, allowed: true, target: "fixture-host-or-read-only" });
      return {};
    }
    // Reuse the already native-proven realpath guard for filesystem reads;
    // shell, writes, delegation and unknown tools remain uniformly denied.
    return filesystem(input, toolUseId, options);
  };
}
