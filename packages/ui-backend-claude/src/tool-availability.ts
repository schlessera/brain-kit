import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

const handlers: Record<string, string> = {
  ask_user: "askUser", ask_user_list: "askUserList", ask_user_rank: "askUserRank",
  ask_user_form: "askUserForm", get_current_location: "getLocation", request_image_mask: "requestMask",
  query_activity: "queryActivity", propose_policy_change: "proposePolicyChange",
  inbox_list: "inboxList", inbox_get: "inboxGet", inbox_add: "inboxAdd", resolve_action: "resolveAction",
  complete_share: "completeShare", brain_read_base: "readBrainBase",
  brain_add: "applyBrain", brain_update: "applyBrain", brain_archive: "applyBrain",
  write_file: "applyBrain", edit_file: "applyBrain", apply_staged_changes: "applyBrain",
};
const visual = new Set(["request_image_mask", "ask_user_list", "ask_user_rank", "ask_user_form"]);
const interactive = new Set(["propose_policy_change", "inbox_add", "resolve_action", "complete_share"]);

/** Registration is stable; these live facts are authority only at call time. */
export function toolAvailabilityRefusal(req: StartTurnRequest, toolName: string): string | undefined {
  if (req.autonomous) return undefined;
  const name = toolName.replace(/^mcp__brain-ui__/, "");
  if (["Write", "Edit", "NotebookEdit"].includes(name)
    && (req.posture === "voice" || req.workerSandbox?.profile === "strict"))
    return "Native writes are unavailable on strict or voice turns.";
  if ((visual.has(name) || interactive.has(name)) && (req.noGrantSurface || req.posture === "voice"))
    return `Tool "${name}" requires an interactive typed grant surface.`;
  const handler = handlers[name];
  if (handler && typeof (req.bridge as unknown as Record<string, unknown>)[handler] !== "function")
    return `Tool "${name}" has no available host handler in this turn.`;
}
