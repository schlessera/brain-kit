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
