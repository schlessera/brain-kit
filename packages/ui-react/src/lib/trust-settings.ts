/** Concrete Settings publication DTOs; the host remains the authority. */
export type TrustSelector =
  | { kind: "web_origin"; scheme: "http" | "https"; host: string; port: number }
  | { kind: "tunnel_authority"; host: string; port: number }
  | { kind: "github_repository"; host: "github.com"; owner: string; repository: string; repositoryId: string }
  | { kind: "github_owner"; host: "github.com"; owner: string; ownerId: string };
export interface TrustRule { id: string; label: string; selector: TrustSelector; incomingContent: boolean; recipientWhileRestricted: boolean }
export interface TrustPolicy { revision: string; policyHash: string | null; error: string | null; rules: TrustRule[] }
export interface TrustCapabilities { originRules: boolean; repositoryRules: boolean; recipientRules: boolean; repositoryIdentity: boolean; readOnlyReason: string | null }
export interface TrustSettingsRead extends TrustPolicy { origins: TrustRule[]; repositories: TrustRule[]; capabilities: TrustCapabilities; mutationAllowed?: boolean }
export type TrustChange = { action: "create" | "edit"; rule: TrustRule } | { action: "remove"; ruleId: string };
export interface TrustOperation {
  receipt: { requestId: string; stage: "prepared" | "file_published" | "committed" | "partial" | "unknown" | "refused"; publication: "not_published" | "proved" | "unknown"; currentRule: "present" | "removed" | "changed" | "unknown"; enforcement: "enforced" | "unavailable"; reason: string | null };
  review: { reviewId: string; reviewedBytesHash: string; base: string | null; proposed: string; diff: string; expiresAt: number; includesFutureRepositories: boolean };
  policy: TrustPolicy; capabilities: TrustCapabilities;
}
export function trustTarget(selector: TrustSelector): string {
  switch (selector.kind) {
    case "web_origin": return `${selector.scheme}://${selector.host}:${selector.port}`;
    case "tunnel_authority": return `${selector.host}:${selector.port} · opaque tunnel`;
    case "github_repository": return `github.com/${selector.owner}/${selector.repository} · repository ID ${selector.repositoryId}`;
    case "github_owner": return `github.com/${selector.owner} · owner ID ${selector.ownerId} · includes future repositories`;
  }
}
