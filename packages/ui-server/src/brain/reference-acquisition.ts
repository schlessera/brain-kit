/** Retained host acquisition facts. Neither a directory exemption nor a model read receipt. */
import type { Database } from "bun:sqlite";
import type { NativePoolRecord } from "@schlessera/brain-ui-sdk/internal";
import type { GitHubReferenceIdentity } from "./github-reference-identity.js";
import type { createGitHubReferenceAccess } from "./github-reference-access.js";

export interface ReferenceAcquisitionContext {
  /** Both values come from the admitted host turn, never from tool input. */
  turnId: string;
  egress: Parameters<ReturnType<typeof createGitHubReferenceAccess>["open"]>[0]["egress"];
  /** Principal/turn and shared recorder health, read again after host waits. */
  current(): boolean;
}

export interface ReferenceAcquisition {
  id: string;
  brain: string;
  principalId: string;
  turnId: string;
  identity: GitHubReferenceIdentity;
  ref: string;
  commit: string;
  tree: string;
  root: NonNullable<NativePoolRecord["root"]>;
  grantId: string | null;
  networkBytes: number;
  at: number;
}

/** Compare retained facts to the manager's current sealed root; paths and names are not identities. */
export function referenceAcquisitionMatches(db: Database, id: string, record: NativePoolRecord, expected: {
  brain: string; commit: string; ref: string | null; identity?: GitHubReferenceIdentity;
}): boolean {
  const row = db.query(`SELECT brain, commit_id, ref, repository_id, owner_id, owner, repository_name, native_root_id, native_uuid, native_generation
    FROM reference_acquisitions WHERE root_id = ?`).get(id) as {
      brain: string; commit_id: string; ref: string;
      repository_id: string; owner_id: string; owner: string; repository_name: string;
      native_root_id: string; native_uuid: string; native_generation: string;
    } | null;
  return Boolean(row && record.id === id && record.purpose === "source" && record.state === "sealed" && record.root
    && row.brain === expected.brain && row.commit_id === expected.commit && row.ref === expected.ref
    && row.native_root_id === record.root.rootId && row.native_uuid === record.root.uuid && row.native_generation === record.root.otransid
    && (!expected.identity || row.repository_id === expected.identity.repositoryId && row.owner_id === expected.identity.ownerId
      && row.owner === expected.identity.owner && row.repository_name === expected.identity.repository));
}

/** One request's fixed-wire observation, including when it reuses an older sealed acquisition. */
export interface ReferenceIdentityObservation {
  operationId: string;
  brain: string;
  principalId: string;
  turnId: string;
  identity: GitHubReferenceIdentity;
  ref: string;
  commit: string;
  rootId: string;
  observedAt: number;
}

/** Recording checks correlation, never converts retained metadata into source trust. */
export function referenceIdentityObservationMatches(observation: ReferenceIdentityObservation | undefined, acquisition: {
  brain: string; repository_id: string; owner_id: string; owner: string; repository_name: string; ref: string; commit_id: string;
}, expected: { brain: string; principalId: string; turnId: string; rootId: string }): boolean {
  const o = observation;
  return Boolean(o && typeof o.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(o.operationId) && Number.isSafeInteger(o.observedAt) && o.observedAt > 0
    && o.brain === expected.brain && o.brain === acquisition.brain && o.principalId === expected.principalId && o.turnId === expected.turnId
    && o.rootId === expected.rootId && o.ref === acquisition.ref && o.commit === acquisition.commit_id
    && o.identity.repositoryId === acquisition.repository_id && o.identity.ownerId === acquisition.owner_id
    && o.identity.owner === acquisition.owner && o.identity.repository === acquisition.repository_name);
}
