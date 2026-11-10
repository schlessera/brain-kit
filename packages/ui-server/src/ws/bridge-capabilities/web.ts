import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";
import type { TurnTranscript } from "./emission.js";

/**
 * The host-owned web tools (#3685): Pi's governed and strict interactive
 * turns, typed or voice (the tools need no card). The scope (principal,
 * session, turn, tool-call id, profile and policy revision) and the
 * cancellation signal are this turn's, captured here; the call carries its tool, parsed input and the model's call id.
 * Liveness is checked by the live-authority wrapper before dispatch and by
 * the broker again before any result returns.
 */
export function createWebAccess(ctx: Pick<BridgeContext, "host" | "turn" | "turnId" | "principalId" | "signal" | "backendId" | "workerProfile" | "current" | "recordingAvailable">,
  transcript: Pick<TurnTranscript, "collectedSessionId">, governance: MakeBridgeOptions["governance"]): Partial<BridgeSlice<"webAccess">> {
  const { host, turn, turnId, principalId, signal, backendId, workerProfile, current, recordingAvailable } = ctx;
  const broker = host.webTools;
  if (!broker || backendId !== "pi") return {};
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
      call, signal, () => current() && recordingAvailable());
    },
  };
}
