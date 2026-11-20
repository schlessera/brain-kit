/** Read-only owner qualification. This records historical evidence, never a source-trust admission. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openGovernancePolicyAnchored, verifyGovernancePolicyAnchored, parseGovernancePolicy,
  TrustedSourcesSchema, TrustSelectorSchema, type TrustSelector, type AnchoredGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { ReferenceIdentityObservation } from "./reference-acquisition.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u).refine(value => BigInt(value) <= 18446744073709551615n);
const identitySchema = z.strictObject({ selector: TrustSelectorSchema, ownerId: providerId, private: z.boolean().nullable() });
const proofSchema = z.strictObject({ operationId: id, principal: z.string().min(1).max(128), brain: digest,
  authority: z.string().min(1).max(4096), baseHash: digest.nullable(), expectedTrustRevision: revision,
  publishedTrustRevision: revision, reviewedBytesHash: digest, githubIdentity: identitySchema });

export interface ReferenceOwnerRoot { path: string; device: number; inode: number }
/** Bind the host's configured directory once; later aliases/replacements cannot select another brain. */
export function captureReferenceOwnerRoot(path: string | undefined): Readonly<ReferenceOwnerRoot> | undefined {
  if (!path) return;
  try { const canonical = realpathSync(path), stat = lstatSync(canonical);
    return stat.isDirectory() ? Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino }) : undefined;
  } catch { return; }
}

type GitHubSelector = Extract<TrustSelector, { kind: "github_owner" | "github_repository" }>;
export interface ReferenceOwnerResolution {
  version: 1;
  operationId: string;
  state: "available" | "unavailable";
  policyHash: string | null;
  trustRevision: string | null;
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
export function resolveReferenceOwners(db: Database, root: Readonly<ReferenceOwnerRoot> | undefined, observation: Readonly<ReferenceIdentityObservation>): ReferenceOwnerResolution {
  const unavailable = (): ReferenceOwnerResolution => ({ version: 1, operationId: observation.operationId,
    state: "unavailable", policyHash: null, trustRevision: null, bindings: [] });
  if (!root) return unavailable();
  let target: AnchoredGovernancePolicy | undefined;
  try {
    const brain = hash(root.path);
    target = openGovernancePolicyAnchored(root.path);
    if (target.directories[0]!.dev !== root.device || target.directories[0]!.ino !== root.inode) return unavailable();
    if (target.bytes === null) return unavailable();
    const policyHash = hash(target.bytes), parsed = parseGovernancePolicy(target.bytes);
    if (!parsed.ok) return unavailable();
    const rules = TrustedSourcesSchema.parse(parsed.effective.taint.trusted_sources);
    const projection = db.query("SELECT revision,rules,policy_hash,error FROM trust_settings_projection WHERE brain_id=?").get(brain) as {
      revision: string; rules: string; policy_hash: string | null; error: string | null;
    } | null;
    if (!projection || projection.error !== null || projection.policy_hash !== policyHash || !revision.safeParse(projection.revision).success
      || JSON.stringify(TrustedSourcesSchema.parse(JSON.parse(projection.rules))) !== JSON.stringify(rules)) return unavailable();
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
          || proof.brain !== brain || BigInt(proof.publishedTrustRevision) !== BigInt(proof.expectedTrustRevision) + 1n
          || BigInt(proof.publishedTrustRevision) > BigInt(projection.revision)
          || identity.ownerId !== current.ownerId
          || (selector.kind === "github_owner" ? identity.private !== null || identity.ownerId !== selector.ownerId : typeof identity.private !== "boolean")) continue;
        bindings.push({ ruleId: rule.id, selector, approvedOwnerId: identity.ownerId,
          sameOwnerRenameRevalidated: selector.kind === "github_repository" && selector.repository !== current.repository,
          publicationOperationId: proof.operationId, publicationProofHash: hash(row.proof) });
      } catch { /* Malformed or incomplete publication evidence qualifies no rule. */ }
    }
    // Detect descriptor/name/content changes while synchronous database reads ran.
    verifyGovernancePolicyAnchored(target, policyHash);
    return { version: 1, operationId: observation.operationId, state: bindings.length ? "available" : "unavailable",
      policyHash, trustRevision: projection.revision, bindings };
  } catch { return unavailable(); }
  finally { target?.close(); }
}
