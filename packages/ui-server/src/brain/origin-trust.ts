/** Host-only prospective origin decisions. Repository proof belongs to its own collector. */
import { matchTrustRules, type TrustMatch, type TrustProvenance, type TrustRule } from "@schlessera/brain-common/internal/governance-policy";
import type { LiveTrustRevision } from "../governance/effective-safety.js";

export interface OriginTrust extends LiveTrustRevision {
  refresh?(signal?: AbortSignal): Promise<unknown>;
  read(): { revision: string; rules: TrustRule[]; policyHash: string | null; readonly ruleInstances: Readonly<Record<string,string>> };
}
export interface OriginDestination { host: string; port: number; method: string; protocol?: string; managedReference?: boolean }
function originProvenance(destination: OriginDestination): TrustProvenance | null {
  // Selectors encode IPv6 with URL brackets; transport identity is bare.
  const host = destination.host.includes(":") && !destination.host.startsWith("[") ? `[${destination.host}]` : destination.host;
  if (destination.managedReference && destination.protocol !== "https:") return null;
  if (destination.method === "CONNECT" && !destination.managedReference) return { kind: "tunnel_authority", authority: { kind: "tunnel_authority", host, port: destination.port }, verifiedBy: "host_proxy" };
  if (destination.protocol === "http:" || destination.protocol === "https:") return { kind: "web_origin", origin: { kind: "web_origin", scheme: destination.protocol === "http:" ? "http" : "https", host, port: destination.port }, verifiedBy: "host_transport" };
  return null;
}
export function originTrustMatch(trust: OriginTrust | undefined, destination: OriginDestination, capability: TrustMatch["capability"], collectionRevision: string): TrustMatch | null {
  return originTrustMatchSnapshot(trust?.read(), destination, capability, collectionRevision);
}
/** All admission evidence, including an unmatched verdict, uses this same snapshot. */
export function originTrustMatchSnapshot(p: ReturnType<OriginTrust["read"]> | undefined, destination: OriginDestination, capability: TrustMatch["capability"], collectionRevision: string): TrustMatch | null {
  if (!p) return null;
  const provenance = originProvenance(destination);
  if (!p.policyHash || !provenance) return null;
  return matchTrustRules(p.rules, provenance, capability, { phase: "prospective_admission", trustRevision: p.revision, policyHash: p.policyHash, collectionRevision },
    value => value.kind === "web_origin" ? { kind: "host_transport" } : value.kind === "tunnel_authority" ? { kind: "host_proxy" } : { kind: "unknown" });
}
