import { PROPOSE_POLICY_CHANGE_TOOL_NAME, type PolicyChangeInput } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { ApprovalChannel } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { approvalRequestFrame, withTurnScope } from "../frames.js";
import type { BridgeContext, BridgeSlice } from "./context.js";

/**
 * Permission requests: a remembered grant, a policy proposal's checkpoint, or
 * an approval card parked until the user answers. `self` is the composed
 * bridge, read at call time: a proposal checkpoint goes to the bridge's
 * current `proposePolicyChange`.
 */
export function createPermissions(ctx: BridgeContext, self: () => BackendBridge): BridgeSlice<"requestPermission"> {
  const { host, turn, turnId, recorder } = ctx;
  const { coordinator } = host;
  return {
    requestPermission: (req) => {
      // A native permission checkpoint delegates this particular operation to
      // the host validator. Invalid input never raises a generic approval card.
      // Its handler later reads the SAME request receipt, without another write.
      if (req.kind !== "policy" && [PROPOSE_POLICY_CHANGE_TOOL_NAME, `mcp__brain-ui__${PROPOSE_POLICY_CHANGE_TOOL_NAME}`].includes(req.toolName)) {
        const bridge = self();
        if (!bridge.proposePolicyChange) return Promise.resolve({ behavior: "deny", message: "Policy proposals are unavailable in this turn." });
        return bridge.proposePolicyChange(req.toolUseId, req.input as PolicyChangeInput)
          .then(review => review.state === "updated" ? { behavior: "allow" as const } : { behavior: "deny" as const, message: review.message },
            error => ({ behavior: "deny" as const, message: error instanceof Error ? error.message : "Invalid policy proposal." }));
      }
      // A remembered "always allow" answers grantable tool requests without
      // a card. NEVER for kind "command" — those are destructive-pattern
      // confirmations for tools that are already auto-allowed, and
      // remembering them would silently disable the seatbelt. NEVER either
      // when the backend says the turn's enforced allowlist left this tool
      // out: the grant was given under a wider posture and answering with it
      // would make the narrower one decoration.
      //
      // The store is still READ for such a request, and only read: a grant
      // that exists and is deliberately not applied is the thing worth a
      // record, and there is nothing to record without looking. What the
      // enforced posture forbids is answering from the store (here) and
      // adding to it (dispatch.ts) — not knowing what is in it.
      const remembered =
        req.kind !== "command" && req.kind !== "policy" && host.toolPermissions?.isAutoAllowed(req.toolName) === true;
      if (remembered && req.outsideEnforcedAllowlist) {
        // Body stays constant and the reason rides as an attribute, matching
        // the refusal dispatch.ts records on the write side. A reason spliced
        // into the body reads better in a terminal and aggregates worse: two
        // halves of one policy would not group, and neither would two reasons
        // for the same half.
        host.log.emit({
          severityText: "INFO",
          body: "remembered tool grant not applied",
          attributes: {
            "tool.name": req.toolName,
            "toolUse.id": req.toolUseId,
            reason: "outside this turn's enforced allowlist",
          },
        });
      }
      if (remembered && !req.outsideEnforcedAllowlist) {
        return Promise.resolve({ behavior: "allow" });
      }
      return new Promise<PermissionDecision>((resolve) => {
        // The decision stamps the wait/execution boundary on the tool span
        // (grant) or lands the denied outcome (deny) before the backend's
        // own error tool_result can mislabel it — write-once protects it.
        const recorded = (
          decision: PermissionDecision,
          response?: { principalId: string; always?: boolean; channel?: ApprovalChannel }
        ) => {
          recorder?.onApprovalDecision(
            req.toolUseId,
            decision.behavior === "deny"
              ? "deny"
              : response?.always
                ? "always_allow"
                : "allow",
            req.kind ?? "tool",
            response?.principalId,
            response?.channel
          );
          resolve(decision);
        };
        if (!coordinator.openApproval(req.toolUseId, { turn, turnId, request: req, resolve: recorded })) {
          resolve({ behavior: "deny", message: "Duplicate tool-approval id" });
          return;
        }
        if (!host.clients.hasClients()) {
          // Not a failure — the card is parked and re-delivered on reconnect
          // (see resendPendingInteractive) — but the wait was invisible before
          // this line existed, and it is bounded only by the turn timeout.
          host.log.emit({
            severityText: "WARN",
            body: "approval requested with no client connected; holding for reconnect",
            attributes: { "tool.name": req.toolName, "toolUse.id": req.toolUseId },
          });
        }
        host.sendToClients(
          withTurnScope(
            approvalRequestFrame(req, host.toolPermissions !== null),
            turn,
            turnId
          )
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: `Waiting for approval: ${req.toolName}` },
            turn,
            turnId
          )
        );
        if (turn.sessionId) {
          host.conversations?.approvalRaised({ sessionId: turn.sessionId, turnId, toolUseId: req.toolUseId, toolName: req.toolName });
        }
      });
    },
  };
}
