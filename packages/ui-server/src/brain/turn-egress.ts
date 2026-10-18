/** One admitted turn's concrete proxy, approval surface and durable records. */
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { startEgressProxy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { requestToolPermission, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { GovernanceEventInput } from "../governance/events.js";

export async function prepareTurnEgress(options: {
  policy: EffectiveGovernancePolicy; bridge: BackendBridge; controller: AbortController;
  turnId: string; sessionId: () => string | null; model: () => string | null;
  profile: "governed" | "strict"; origin: "interactive" | "voice";
  record(event: GovernanceEventInput): void;
}) {
  let recordingFailure: Error | undefined;
  const report = (record: EgressRecord): void => {
    try {
      const base = { turnId: options.turnId, sessionId: options.sessionId(), model: options.model(),
        actor: options.origin, profile: options.profile };
      options.record({ ...base, kind: "egress_connection", payload: record });
      const denied = options.policy.egress.deny.some(pattern => {
        const normalized = pattern.toLowerCase().replace(/\.$/, "");
        return normalized.startsWith("*.") ? record.host.endsWith(normalized.slice(1)) && record.host !== normalized.slice(2) : record.host === normalized;
      });
      const reason = record.reason === "destination_not_allowed" ? denied ? "denied_host" : "not_allowlisted"
        : record.reason === "max_bytes_per_turn" ? "byte_cap" : undefined;
      if (reason) options.record({ ...base, kind: "egress_denial", payload: {
        host: record.host, port: record.port, method: record.method, reason, bytes: record.bytes,
      } });
    } catch {
      recordingFailure ??= new Error("Turn egress recording is unavailable");
      options.controller.abort(recordingFailure);
    }
  };
  const proxy = await startEgressProxy({ mode: options.policy.egress.mode, allow: options.policy.egress.allow,
    deny: options.policy.egress.deny, maxBytes: options.policy.egress.max_bytes_per_turn ?? Number.MAX_SAFE_INTEGER,
    outwardHosts: [...new Set(["api.github.com", "uploads.github.com", ...options.policy.outward.hosts])],
    signal: options.controller.signal, observe: report,
    approveOutward: async (destination, signal) => {
      const decision = await requestToolPermission(options.bridge, { toolUseId: crypto.randomUUID(), toolName: "Network",
        kind: "command", input: destination,
        description: `${destination.method} to ${destination.host}:${destination.port}`,
      }, { noGrantSurface: options.origin === "voice" });
      return !signal.aborted && decision.behavior === "allow";
    },
  });
  return { ...proxy, recordingFailure: () => recordingFailure };
}
