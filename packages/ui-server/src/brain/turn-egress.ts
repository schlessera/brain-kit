/** One admitted turn's concrete proxy, approval surface and durable records. */
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { startEgressProxy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { requestToolPermission, type BackendActivityEvent, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { Database } from "bun:sqlite";
import type { GovernanceEventInput } from "../governance/events.js";
import { contactedHosts, recordFirstTaint, sessionTaint } from "../governance/session-taint.js";

type Classification = Extract<BackendActivityEvent, { kind: "outward_classification" }>["classification"];
const GITHUB_API_HOSTS = ["api.github.com", "uploads.github.com"] as const;
/**
 * Built-in mail submission (G5). SMTP submission is defined by its port, so
 * any host on these ports is outward; the hosts are HTTP mail-send APIs and
 * provider relays on alternate ports. `outward.hosts` adds the rest.
 */
export const MAIL_SUBMISSION_PORTS = [25, 465, 587] as const;
export const MAIL_SUBMISSION_HOSTS = ["gmail.googleapis.com", "graph.microsoft.com", "outlook.office365.com",
  "api.fastmail.com", "api.sendgrid.com", "smtp.sendgrid.net", "api.mailgun.net", "api.eu.mailgun.net", "smtp.mailgun.org",
  "smtp.eu.mailgun.org", "api.postmarkapp.com", "smtp.postmarkapp.com", "api.resend.com", "smtp.resend.com"] as const;

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
  /** The record the session's taint and contacted hosts are read from (G6). Absent: no taint narrowing. */
  governanceDb?: Database;
}) {
  const calls = createOutwardCalls();
  let recordingFailure: Error | undefined;
  const db = options.governanceDb;
  // Hosts earlier turns of the session reached, then every host this turn admits.
  const contacted = new Set(db ? contactedHosts(db, options.sessionId()) : []);
  let tainted = false;
  const base = () => ({ turnId: options.turnId, sessionId: options.sessionId(), model: options.model(),
    actor: options.origin, profile: options.profile });
  const fail = () => {
    recordingFailure ??= new Error("Turn egress recording is unavailable");
    options.controller.abort(recordingFailure);
  };
  const report = (record: EgressRecord): void => {
    if (!options.record) return;
    try {
      options.record({ ...base(), kind: "egress_connection", payload: record });
      const denied = options.policy.egress.deny.some(pattern => {
        const normalized = pattern.toLowerCase().replace(/\.$/, "");
        return normalized.startsWith("*.") ? record.host.endsWith(normalized.slice(1)) && record.host !== normalized.slice(2) : record.host === normalized;
      });
      const reason = record.reason === "destination_not_allowed" ? denied ? "denied_host" : "not_allowlisted"
        : record.reason === "max_bytes_per_turn" ? "byte_cap" : record.reason === "taint_not_allowed" ? "taint_allowlist" : undefined;
      if (reason) options.record({ ...base(), kind: "egress_denial", payload: {
        host: record.host, port: record.port, method: record.method, reason, bytes: record.bytes,
      } });
    } catch { fail(); }
  };
  /**
   * Any admitted connection other than the inference relay taints the session
   * (G6), recorded before its first byte. Sticky: once read, never re-read.
   */
  const taint = db ? {
    allow: options.policy.taint.egress.allow,
    tainted: () => tainted ||= sessionTaint(db, options.turnId, options.sessionId()) !== null,
    contacted: (host: string) => contacted.has(host),
  } : undefined;
  const admitted = (destination: { host: string; port: number; method: string; inference: boolean }): void => {
    if (destination.inference) return;
    contacted.add(destination.host);
    if (!db || !options.record || tainted) return;
    try {
      recordFirstTaint(db, { ...base(), kind: "taint", payload: { source: "egress_connection", tool: null,
        detail: `${destination.method} ${destination.host}:${destination.port}` } }, options.record);
      tainted = true;
    } catch (error) { fail(); throw error; }
  };
  const proxy = await startEgressProxy({ mode: options.policy.egress.mode, allow: options.policy.egress.allow,
    deny: options.policy.egress.deny, maxBytes: options.policy.egress.max_bytes_per_turn ?? Number.MAX_SAFE_INTEGER,
    outwardHosts: [...new Set([...GITHUB_API_HOSTS, ...MAIL_SUBMISSION_HOSTS, ...options.policy.outward.hosts])],
    outwardPorts: MAIL_SUBMISSION_PORTS,
    signal: options.controller.signal, observe: report, admitted, ...(taint ? { taint } : {}),
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
