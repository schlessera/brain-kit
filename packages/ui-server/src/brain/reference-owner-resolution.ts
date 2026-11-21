import { lstatSync } from "node:fs";
import { trustPolicyGeneration } from "./trust-policy-generation.js";
/** Read-only owner qualification. This records historical evidence, never a source-trust admission. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { TrustedSourcesSchema, TrustSelectorSchema, type TrustSelector } from "@schlessera/brain-common/internal/governance-policy";
import type { ReferenceIdentityObservation } from "./reference-acquisition.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u).refine(value => BigInt(value) <= 18446744073709551615n);
const identitySchema = z.strictObject({ selector: TrustSelectorSchema, ownerId: providerId, private: z.boolean().nullable() });
const proofSchema = z.strictObject({ operationId: id, principal: z.string().min(1).max(128), brain: digest,
  authority: z.string().min(1).max(4096),
  policyRoot: z.strictObject({ fsid: z.string().uuid(), uuid: z.string().regex(/^[a-f0-9]{32}$/u) }), baseHash: digest.nullable(), expectedTrustRevision: revision,
  publishedTrustRevision: revision, reviewedBytesHash: digest, githubIdentity: identitySchema });

export { createReferenceOwnerContinuity } from "./reference-owner-native-root.js";
import type { ReferenceOwnerRoot } from "./reference-owner-native-root.js";
export type { ReferenceOwnerRoot } from "./reference-owner-native-root.js";

export interface ReferenceOwnerPolicy {
  rules: import("@schlessera/brain-common/internal/governance-policy").TrustRule[];
  revision: string; policyHash: string | null; error: string | null; generation: string;
}
const policySchema = z.strictObject({ rules: TrustedSourcesSchema, revision, policyHash: digest.nullable(),
  error: z.string().nullable(), generation: z.string().min(1).max(4096) });

type GitHubSelector = Extract<TrustSelector, { kind: "github_owner" | "github_repository" }>;
export interface ReferenceOwnerResolution {
  version: 1;
  operationId: string;
  state: "available" | "unavailable";
  policyHash: string | null;
  trustRevision: string | null;
  policyError: string | null;
  /** At most one repository and one owner rule can match a validated policy. */
  bindings: { ruleId: string; selector: GitHubSelector; approvedOwnerId: string; sameOwnerRenameRevalidated: boolean;
    publicationOperationId: string; publicationProofHash: string }[];
}

/**
 * Called only after the read's real transport observation and immutable blob
 * have been checked. `root` is host configuration, never model input. A valid
 * policy and its exact durable projection must agree; equal bytes cannot create
 * approval. The publisher's retained boundary survives operation pruning.
 */
export function resolveReferenceOwners(db: Database, root: Readonly<ReferenceOwnerRoot> | undefined, observation: Readonly<ReferenceIdentityObservation>, policy?: ReferenceOwnerPolicy): ReferenceOwnerResolution {
  const unavailable = (): ReferenceOwnerResolution => ({ version: 1, operationId: observation.operationId,
    state: "unavailable", policyHash: null, trustRevision: null, policyError: null, bindings: [] });
  if (!root) return unavailable();
  try {
    const brain = hash(root.path), selected = policySchema.parse(policy);
    const named = lstatSync(root.path);
    if (!named.isDirectory() || named.dev !== root.device || named.ino !== root.inode) return unavailable();
    if (trustPolicyGeneration(root.path) !== selected.generation) return unavailable();
    const { policyHash, rules } = selected;
    const projection = db.query("SELECT revision,rules,policy_hash,error FROM trust_settings_projection WHERE brain_id=?").get(brain) as {
      revision: string; rules: string; policy_hash: string | null; error: string | null;
    } | null;
    if (!projection || projection.revision !== selected.revision || !revision.safeParse(projection.revision).success
      || JSON.stringify(TrustedSourcesSchema.parse(JSON.parse(projection.rules))) !== JSON.stringify(rules)
      || selected.error !== null && projection.policy_hash !== policyHash) return unavailable();
    const bindings: ReferenceOwnerResolution["bindings"] = [];
    for (const rule of rules) {
      const selector = rule.selector;
      if (selector.kind !== "github_repository" && selector.kind !== "github_owner") continue;
      const current = observation.identity;
      if (selector.owner !== current.owner || (selector.kind === "github_repository" ? selector.repositoryId !== current.repositoryId : selector.ownerId !== current.ownerId)) continue;
      const row = db.query("SELECT selector,identity,proof FROM trust_settings_github_boundaries WHERE brain_id=? AND rule_id=?").get(brain, rule.id) as {
        selector: string; identity: string; proof: string;
      } | null;
      if (!row || row.selector !== JSON.stringify(selector)) continue;
      try {
        const identity = identitySchema.parse(JSON.parse(row.identity)), proof = proofSchema.parse(JSON.parse(row.proof));
        if (JSON.stringify(identity.selector) !== JSON.stringify(selector) || JSON.stringify(proof.githubIdentity) !== JSON.stringify(identity)
          || proof.brain !== brain || proof.policyRoot.fsid !== root.native.fsid || proof.policyRoot.uuid !== root.native.uuid || BigInt(proof.publishedTrustRevision) !== BigInt(proof.expectedTrustRevision) + 1n
          || BigInt(proof.publishedTrustRevision) > BigInt(projection.revision)
          || identity.ownerId !== current.ownerId
          || (selector.kind === "github_owner" ? identity.private !== null || identity.ownerId !== selector.ownerId : typeof identity.private !== "boolean")) continue;
        bindings.push({ ruleId: rule.id, selector, approvedOwnerId: identity.ownerId,
          sameOwnerRenameRevalidated: selector.kind === "github_repository" && selector.repository !== current.repository,
          publicationOperationId: proof.operationId, publicationProofHash: hash(row.proof) });
      } catch { /* Malformed or incomplete publication evidence qualifies no rule. */ }
    }
    // Detect descriptor/name/content changes while synchronous database reads ran.
    if (trustPolicyGeneration(root.path) !== selected.generation) return unavailable();
    return { version: 1, operationId: observation.operationId, state: bindings.length ? "available" : "unavailable",
      policyHash, trustRevision: projection.revision, policyError: selected.error, bindings };
  } catch { return unavailable(); }
}
