import { PROPOSE_POLICY_CHANGE_TOOL_NAME } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { GOVERNANCE_POLICY_PATH } from "@schlessera/brain-common/internal/governance-policy";
import { withTurnScope } from "../frames.js";
import type { BridgeContext, BridgeSlice } from "./context.js";

/**
 * The policy proposal tool, outside voice. `self` is the composed bridge, read
 * at call time: its approval goes through the bridge's current
 * `requestPermission`, live-authority wrapper included.
 */
export function createPolicyProposal(ctx: BridgeContext, self: () => BackendBridge): Partial<BridgeSlice<"proposePolicyChange">> {
  const { host, turn, turnId, principalId, signal, work, backendId, maskGuard, toolName, principalIsAuthorized, recordingAvailable, scopePaused, holdOf } = ctx;
  if (!host.policyProposals || work?.posture === "voice") return {};
  return {
    proposePolicyChange: async (requestId, input) => {
      // The policy file is a document too: a policy masking its folder hides it here as well.
      maskGuard?.assert(toolName(PROPOSE_POLICY_CHANGE_TOOL_NAME), [GOVERNANCE_POLICY_PATH]);
      return host.policyProposals!.propose({
        // Publication runs inside its own journal observation, so only a scope pause holds it.
        principalId, turnId, sessionId: () => turn.sessionId, signal, isAuthorized: () => principalIsAuthorized() && recordingAvailable() && !scopePaused(),
        hold: holdOf(scopePaused), isAvailable: () => work?.posture !== "voice",
        approve: async review => {
          const decision = await self().requestPermission({ toolUseId: requestId,
            toolName: backendId === "claude" ? `mcp__brain-ui__${PROPOSE_POLICY_CHANGE_TOOL_NAME}` : PROPOSE_POLICY_CHANGE_TOOL_NAME,
            input: { ...input, policyReview: review }, kind: "policy", description: review.message });
          return decision.behavior === "allow" && decision.updatedInput === undefined;
        },
        emit: review => host.sendToClients(withTurnScope({ type: "tool_result", toolUseId: requestId,
          output: JSON.stringify(review), isError: !["pending", "writing", "updated", "declined"].includes(review.state), policyChange: review }, turn, turnId)),
      }, requestId, input);
    },
  };
}
