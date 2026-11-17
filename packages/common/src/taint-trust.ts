/** Data-only trust policy and prospective matching. No transport or authority is established here. */
import { z } from "zod";

export const TRUST_LIMITS = Object.freeze({ rules: 256, selectorBytes: 1024, sectionBytes: 262144, labelBytes: 128 });
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
const bounded = (max: number) => z.string().max(max).refine(value => utf8(value) <= max, "UTF-8 byte limit exceeded");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine(value => /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= 18446744073709551615n, "Revision exhausted");
const port = z.number().int().min(1).max(65535);

/** URL's installed IDNA/IP implementation is used only after rejecting ambiguous input syntax. */
export function canonicalTrustHost(input: string): string {
  if (!input || utf8(input) > 1024 || /[\s\u0000-\u001f\u007f/@?#%\\:*]/u.test(input.replace(/^\[[0-9a-fA-F:.]+\]$/u, "ipv6")))
    throw new Error("Use an exact DNS name or IP literal");
  const ipv6 = input.startsWith("[");
  const host = new URL(`http://${input}`).hostname.toLowerCase();
  if (ipv6) {
    // IPv6 must already be bracketed and compressed, never a zone ID or alternative spelling.
    if (host !== input) throw new Error("Use canonical bracketed compressed IPv6");
    return host;
  }
  if (/^[0-9.]+$/u.test(host)) {
    if (host !== input) throw new Error("Use canonical dotted-decimal IPv4");
    return host;
  }
  const dns = host.endsWith(".") ? host.slice(0, -1) : host;
  if (utf8(dns) > 253 || !dns.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
    throw new Error("Use a valid ASCII/IDNA DNS name");
  return dns;
}
const host = bounded(253).refine(value => { try { return canonicalTrustHost(value) === value; } catch { return false; } }, "Use a canonical host");
const owner = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u).refine(value => !value.includes("--"));
const repository = z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/u).refine(value => value !== "." && value !== "..");
const web = z.strictObject({ kind: z.literal("web_origin"), scheme: z.enum(["http", "https"]), host, port });
const tunnel = z.strictObject({ kind: z.literal("tunnel_authority"), host, port });
const repo = z.strictObject({ kind: z.literal("github_repository"), host: z.literal("github.com"), owner, repository, repositoryId: providerId });
const namespace = z.strictObject({ kind: z.literal("github_owner"), host: z.literal("github.com"), owner, ownerId: providerId });
export const TrustSelectorSchema = z.discriminatedUnion("kind", [web, tunnel, repo, namespace])
  .refine(value => utf8(JSON.stringify(value)) <= TRUST_LIMITS.selectorBytes, "Selector byte limit exceeded");
export type TrustSelector = z.output<typeof TrustSelectorSchema>;

export function parseTrustOrigin(input: string): z.output<typeof web> {
  if (utf8(input) > 1024) throw new Error("Origin byte limit exceeded");
  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[^/:]+)(?::([0-9]+))?\/?$/iu.exec(input);
  if (!match || /[\s\u0000-\u001f\u007f@%?#\\]/u.test(input)) throw new Error("Use a bare HTTP(S) origin");
  const scheme = match[1]!.toLowerCase() as "http" | "https";
  return web.parse({ kind: "web_origin", scheme, host: canonicalTrustHost(match[2]!), port: match[3] === undefined ? (scheme === "https" ? 443 : 80) : Number(match[3]) });
}
export function parseTrustTunnel(input: string): z.output<typeof tunnel> {
  if (utf8(input) > 1024) throw new Error("Tunnel byte limit exceeded");
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:]+):([0-9]+)$/u.exec(input);
  if (!match) throw new Error("Use an explicit host:port tunnel authority");
  return tunnel.parse({ kind: "tunnel_authority", host: canonicalTrustHost(match[1]!), port: Number(match[2]) });
}
/** Parsing names is not stable identity verification; the caller must obtain IDs independently. */
export function parseTrustGithub(input: string): { host: "github.com"; owner: string; repository?: string } {
  if (utf8(input) > 1024) throw new Error("GitHub selector byte limit exceeded");
  const path = input.startsWith("https://github.com/") ? input.slice("https://github.com/".length) : input;
  const parts = path.split("/");
  if (parts.length < 1 || parts.length > 2) throw new Error("Use an exact GitHub owner or owner/repository");
  const canonicalOwner = owner.parse(parts[0]!.toLowerCase());
  if (parts.length === 1) return { host: "github.com", owner: canonicalOwner };
  const name = parts[1]!.replace(/\.git$/iu, "").toLowerCase();
  return { host: "github.com", owner: canonicalOwner, repository: repository.parse(name) };
}
const common = { id, label: bounded(128), incomingContent: z.boolean().default(true), recipientWhileRestricted: z.boolean().default(false) };
export const TrustRuleSchema = z.strictObject({ ...common, selector: TrustSelectorSchema }).superRefine((rule, ctx) => {
  const git = rule.selector.kind.startsWith("github_");
  if ((!rule.incomingContent && !rule.recipientWhileRestricted) || (git && (!rule.incomingContent || rule.recipientWhileRestricted)))
    ctx.addIssue({ code: "custom", message: "Repository rules are incoming-only; origin/tunnel rules need at least one explicit capability" });
});
export type TrustRule = z.output<typeof TrustRuleSchema>;
// Stable field order avoids YAML key-order differences hiding duplicate selectors.
function selectorKey(value: TrustSelector): string {
  switch (value.kind) {
    case "web_origin": return JSON.stringify([value.kind, value.scheme, value.host, value.port]);
    case "tunnel_authority": return JSON.stringify([value.kind, value.host, value.port]);
    case "github_repository": return JSON.stringify([value.kind, value.host, value.owner, value.repository, value.repositoryId]);
    case "github_owner": return JSON.stringify([value.kind, value.host, value.owner, value.ownerId]);
  }
}
export const TrustedSourcesSchema = z.array(TrustRuleSchema).max(TRUST_LIMITS.rules).superRefine((rules, ctx) => {
  if (utf8(JSON.stringify(rules)) > TRUST_LIMITS.sectionBytes) ctx.addIssue({ code: "custom", message: "Trust section byte limit exceeded" });
  const ids = new Set<string>(), selectors = new Set<string>();
  for (const rule of rules) {
    const s = rule.selector;
    const keys = s.kind === "github_repository" ? [`repo-id:${s.repositoryId}`, `repo-name:${s.owner}/${s.repository}`]
      : s.kind === "github_owner" ? [`owner-id:${s.ownerId}`, `owner-name:${s.owner}`] : [selectorKey(s)];
    if (ids.has(rule.id) || keys.some(key => selectors.has(key))) ctx.addIssue({ code: "custom", message: "Duplicate trust rule ID or canonical selector" });
    ids.add(rule.id); for (const key of keys) selectors.add(key);
  }
});

// A conservative ordinary-ref subset. Runtime transport must additionally use Git's ref validator.
const gitRef = bounded(1024).refine(value => /^(refs\/heads\/|refs\/tags\/)/u.test(value)
  && !/[\s\u0000-\u001f\u007f~^:?*\[\\]/u.test(value) && !value.includes("..") && !value.includes("@{")
  && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")), "Use an ordinary full branch/tag ref");
export const TrustProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("web_origin"), origin: web, verifiedBy: z.literal("host_transport") }),
  z.strictObject({ kind: z.literal("tunnel_authority"), authority: tunnel, verifiedBy: z.literal("host_proxy") }),
  z.strictObject({ kind: z.literal("github_read"), repository: repo, ownerId: providerId, ref: gitRef,
    commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u), acquisitionId: id, contentHash: hash,
    immutable: z.literal(true), verifiedBy: z.literal("managed_acquisition") }),
]);
export type TrustProvenance = z.output<typeof TrustProvenanceSchema>;
/** Supplied only by the independent host verifier, never deserialized from a worker's claims. */
export type TrustVerification = { kind: "unknown" } | { kind: "host_transport" } | { kind: "host_proxy" }
  | { kind: "managed_acquisition"; currentIdentity: true; approvedOwnerBoundary: true; sameOwnerRenameRevalidated: boolean };
export interface TrustAdmission {
  phase: "prospective_admission";
  trustRevision: string;
  policyHash: string;
  collectionRevision: string;
}
export interface TrustMatch {
  ruleId: string;
  capability: "incomingContent" | "recipientWhileRestricted";
  trustRevision: string;
  policyHash: string;
  collectionRevision: string;
  provenance: TrustProvenance;
}
/**
 * Pure candidate evaluation, NOT dispatch authorization. Each signal/redirect is evaluated separately.
 * The host must independently bind proof to the actual operation, current authority and this rule.
 * No verifier means unknown, even when the input asserts verifiedBy. No historical verdict API exists.
 */
export function matchTrustRules(rules: readonly TrustRule[], provenance: unknown, capability: TrustMatch["capability"], admission: TrustAdmission,
  verify?: (provenance: TrustProvenance, rule: TrustRule) => TrustVerification): TrustMatch | null {
  const parsed = TrustProvenanceSchema.safeParse(provenance);
  if ((capability !== "incomingContent" && capability !== "recipientWhileRestricted") || !parsed.success || admission.phase !== "prospective_admission" || !revision.safeParse(admission.trustRevision).success
    || !revision.safeParse(admission.collectionRevision).success || !hash.safeParse(admission.policyHash).success) return null;
  const p = parsed.data;
  // Revalidate caller-supplied rules as well; invalid or duplicated policy can never produce a candidate.
  const policy = TrustedSourcesSchema.safeParse(rules);
  if (!policy.success) return null;
  for (const rule of policy.data) {
    if (!rule[capability]) continue;
    const s = rule.selector;
    const proof = verify?.(p, rule) ?? { kind: "unknown" };
    let matches = false;
    if (p.kind === "web_origin" && s.kind === "web_origin" && proof.kind === "host_transport") matches = selectorKey(s) === selectorKey(p.origin);
    if (p.kind === "tunnel_authority" && s.kind === "tunnel_authority" && proof.kind === "host_proxy") matches = selectorKey(s) === selectorKey(p.authority);
    if (p.kind === "github_read" && proof.kind === "managed_acquisition" && proof.currentIdentity === true && proof.approvedOwnerBoundary === true && capability === "incomingContent") {
      if (s.kind === "github_repository") matches = s.owner === p.repository.owner && s.repositoryId === p.repository.repositoryId
        && (s.repository === p.repository.repository || proof.sameOwnerRenameRevalidated === true);
      if (s.kind === "github_owner") matches = s.owner === p.repository.owner && s.ownerId === p.ownerId;
    }
    if (matches) return structuredClone({ ruleId: rule.id, capability, trustRevision: admission.trustRevision, policyHash: admission.policyHash,
      collectionRevision: admission.collectionRevision, provenance: p });
  }
  return null;
}
/** Honest implementation availability. Parsing/candidate matching enables no host capability. */
export const TRUST_RUNTIME_CAPABILITIES = Object.freeze({ originRules: false, repositoryRules: false, recipientRules: false,
  readOnlyReason: "Trust admission, publication and verified repository transport are not implemented" });
