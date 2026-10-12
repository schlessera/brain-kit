import { tool } from "@anthropic-ai/claude-agent-sdk";
import { PROPOSE_POLICY_CHANGE_CONTRACT, PROPOSE_POLICY_CHANGE_INPUT_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { askRequestId, TOOL_USE_ID_META_KEY } from "./tool-use-id.js";
export function createPolicyProposalTool(handler: NonNullable<BackendBridge["proposePolicyChange"]>) {
  return tool(PROPOSE_POLICY_CHANGE_CONTRACT.name, PROPOSE_POLICY_CHANGE_CONTRACT.description,
    PROPOSE_POLICY_CHANGE_INPUT_SCHEMA.shape, async (raw, extra) => {
      try {
        const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.[TOOL_USE_ID_META_KEY];
        if (typeof id !== "string" || !id) throw new Error("Policy review requires the native tool-use identity; no proposal was created.");
        const result = await handler(askRequestId(extra), PROPOSE_POLICY_CHANGE_INPUT_SCHEMA.parse(raw));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: result.state !== "updated" };
      } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Policy proposal refused." }], isError: true }; }
    });
}
