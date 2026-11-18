import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";
import type { TurnTranscript } from "./emission.js";
import { BudgetExceeded } from "../../brain/turn-budgets.js";
import type { WebCallAuthority, WebCallRefusal } from "../../web-tools/broker.js";
import { webRoutingRefusal } from "../../web-tools/routing.js";

/**
 * The host-owned web tools (#3685): Pi's governed and strict interactive
 * turns, typed or voice (the tools need no card). The scope (principal,
 * session, turn, tool-call id, profile and policy revision) and the
 * cancellation signal are this turn's, captured here; the call carries its tool, parsed input and the model's call id.
 * Liveness is checked by the live-authority wrapper before dispatch and by
 * the broker again before any result returns.
 *
 * Each call also carries this turn's authority over the recipients it
 * reaches (#3687): data routing under the turn's frozen provider policy and
 * the conversation's recorded exposures, then the turn's budgets, which
 * refuse once a scope is blocked and count each admitted provider request at
 * unknown cost. A turn without a frozen policy admits no recipient.
 */
export function createWebAccess(ctx: Pick<BridgeContext, "host" | "turn" | "turnId" | "principalId" | "signal" | "backendId" | "workerProfile" | "current" | "recordingAvailable">,
  transcript: Pick<TurnTranscript, "collectedSessionId">, governance: MakeBridgeOptions["governance"],
  providerMasks?: MakeBridgeOptions["providerMasks"]): Partial<BridgeSlice<"webAccess">> {
  const { host, turn, turnId, principalId, signal, backendId, workerProfile, current, recordingAvailable } = ctx;
  const broker = host.webTools;
  if (!broker || backendId !== "pi") return {};
  const authority = (sessionId: string): WebCallAuthority => ({
    async admit(recipient): Promise<WebCallRefusal | null> {
      if (!governance) return { code: "policy_denied", message: "This turn has no frozen governance policy, so no web provider could be admitted." };
      const exposures = host.governedTurns ? await host.governedTurns.exposures([sessionId]) : undefined;
      const routed = webRoutingRefusal(governance.policy.policy, providerMasks?.typeFolders, exposures, recipient);
      if (routed) return routed;
      if (!host.budgets) return null;
      try {
        const blocked = await host.budgets.providerAdmission(turnId, governance.policy.policy);
        return blocked ? { code: "budget_exceeded", message: new BudgetExceeded(blocked, "mid_turn").message } : null;
      } catch { return { code: "unavailable", message: "Budget accounting is unavailable for this turn, so nothing was sent." }; }
    },
    attempt(event) {
      // A failed write leaves the turn's accounting to refuse its next admission.
      void host.budgets?.observeWebProvider(turnId, { attemptId: `web:${event.callId}:${crypto.randomUUID()}`, host: event.host }).catch(() => {});
    },
  });
  return {
    async webAccess(call) {
      const sessionId = transcript.collectedSessionId ?? turn.sessionId ?? null;
      const profile = workerProfile?.actualProfile;
      if (!sessionId || !profile) {
        return { ok: false, tool: call.tool, error: { code: "unavailable", message: "Web tools run only in a governed or strict conversation." } };
      }
      return broker.call({ principalId, sessionId, turnId, toolCallId: call.toolCallId, profile, policyRevision: governance?.policy.hash ?? null },
        // A journal hold pauses effects but revokes nothing; principal authority and
        // qualified input recording must both still hold when a result returns.
        call, signal, () => current() && recordingAvailable(), authority(sessionId));
    },
  };
}
