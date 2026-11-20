/** Host-only prospective origin decisions. Repository proof belongs to its own collector. */
import { matchTrustRules, type TrustMatch, type TrustProvenance, type TrustRule } from "@schlessera/brain-common/internal/governance-policy";
import type { LiveTrustRevision } from "../governance/effective-safety.js";

export interface OriginTrust extends LiveTrustRevision {
  read(): { revision: string; rules: TrustRule[]; policyHash: string | null };
}
export interface OriginDestination { host: string; port: number; method: string; protocol?: string }
function originProvenance(destination: OriginDestination): TrustProvenance | null {
  if (destination.method === "CONNECT") return { kind: "tunnel_authority", authority: { kind: "tunnel_authority", host: destination.host, port: destination.port }, verifiedBy: "host_proxy" };
  if (destination.protocol === "http:" || destination.protocol === "https:") return { kind: "web_origin", origin: { kind: "web_origin", scheme: destination.protocol === "http:" ? "http" : "https", host: destination.host, port: destination.port }, verifiedBy: "host_transport" };
  return null;
}
export function originTrustMatch(trust: OriginTrust | undefined, destination: OriginDestination, capability: TrustMatch["capability"], collectionRevision: string): TrustMatch | null {
  if (!trust) return null;
  const p = trust.read(), provenance = originProvenance(destination);
  if (!p.policyHash || !provenance) return null;
  return matchTrustRules(p.rules, provenance, capability, { phase: "prospective_admission", trustRevision: p.revision, policyHash: p.policyHash, collectionRevision },
    value => value.kind === "web_origin" ? { kind: "host_transport" } : value.kind === "tunnel_authority" ? { kind: "host_proxy" } : { kind: "unknown" });
}
