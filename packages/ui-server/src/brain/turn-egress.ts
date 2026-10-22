/** One admitted turn's concrete proxy, approval surface and durable records. */
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { startEgressProxy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { requestToolPermission, type BackendActivityEvent, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { GovernanceEventInput } from "../governance/events.js";

type Classification = Extract<BackendActivityEvent, { kind: "outward_classification" }>["classification"];
const GITHUB_API_HOSTS = ["api.github.com", "uploads.github.com"] as const;

/** Hosts an approved visible action names; an unresolved destination names none. */
function actionHosts(action: Classification["actions"][number]): readonly string[] {
  if (action.action === "gh_write") return GITHUB_API_HOSTS;
  const host = action.target?.split("/")[0]?.replace(/:[0-9]+$/, "").toLowerCase();
  return host ? [host] : [];
}

/**
 * The tool calls in progress and their outward classification (G5). An
 * outward-host connection skips its card only while every classified call in
 * progress is a visible read, or an approved outward action naming that host.
 * Any unknown or opaque call in progress withholds the exception: the proxy
 * cannot tell which process opened a connection. A call ends at its result.
 */
export function createOutwardCalls() {
  const calls = new Map<string, { read: boolean; hosts: readonly string[] } | null>();
  return {
    activity(event: BackendActivityEvent): void {
      if (event.kind !== "outward_classification") return;
      // A refused or declined call never runs.
      if (event.decision !== "allow") { calls.delete(event.toolUseId); return; }
      const classification = event.classification;
      calls.set(event.toolUseId, classification.opaque ? null
        : classification.kind === "read" ? { read: true, hosts: [] }
        : classification.kind === "outward" ? { read: false, hosts: classification.actions.flatMap(actionHosts) } : null);
    },
    emitted(message: Parameters<BackendBridge["emit"]>[0]): void {
      if (message.type === "tool_result") calls.delete(message.toolUseId);
    },
    covers(host: string): boolean {
      const active = [...calls.values()];
      return active.length > 0 && active.every(call => call !== null)
        && active.some(call => call!.read || call!.hosts.includes(host));
    },
  };
}

export async function prepareTurnEgress(options: {
  policy: EffectiveGovernancePolicy; bridge: BackendBridge; controller: AbortController;
  turnId: string; sessionId: () => string | null; model: () => string | null;
  profile: "governed" | "strict"; origin: "interactive" | "voice";
  /** Absent when the host keeps no governance record: limits still apply. */
  record?(event: GovernanceEventInput): void;
}) {
  const calls = createOutwardCalls();
  let recordingFailure: Error | undefined;
  const report = (record: EgressRecord): void => {
    if (!options.record) return;
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
      if (calls.covers(destination.host)) return !signal.aborted;
      const decision = await requestToolPermission(options.bridge, { toolUseId: crypto.randomUUID(), toolName: "Network",
        kind: "command", input: destination,
        description: `${destination.method} to ${destination.host}:${destination.port}`,
      }, { noGrantSurface: options.origin === "voice" });
      return !signal.aborted && decision.behavior === "allow";
    },
  });
  const original = options.bridge;
  /** The bridge the backend receives, so its classifications and results open and close each call. */
  const bridge: BackendBridge = { ...original,
    emit(message) { calls.emitted(message); original.emit(message); },
    activity(event) { calls.activity(event); original.activity?.(event); },
  };
  return { ...proxy, bridge, recordingFailure: () => recordingFailure };
}
