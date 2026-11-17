/** Shared invalidation versions, not source trust or private-access grants. */
import type { Database } from "bun:sqlite";
import { referenceRepository } from "../db/reference-grants.js";

export interface SourceAuthority {
  domain: string;
  repository: string;
  revision: string;
  repositoryFence: string;
  revisionFence: string;
}

/** Keys are already canonical: normalize GitHub casing without removing a suffix. */
export const authorityRepository = (repository: string) => referenceRepository(repository, { prefix: true }).url;

export function sourceAuthority(db: Database, domain: string, repository: string, revision: string): SourceAuthority {
  repository = authorityRepository(repository);
  const rows = db.query("SELECT revision, generation FROM reference_authority_fences WHERE domain = ? AND repository = ? AND revision IN ('', ?)")
    .all(domain, repository, revision) as { revision: string; generation: string }[];
  return { domain, repository, revision, repositoryFence: rows.find(row => row.revision === "")?.generation ?? "",
    revisionFence: rows.find(row => row.revision === revision)?.generation ?? "" };
}

/** The writer also calls this inside its publication/validation transaction. */
export function sourceAuthorityCurrent(db: Database, expected: SourceAuthority): boolean {
  const current = sourceAuthority(db, expected.domain, expected.repository, expected.revision);
  return current.repositoryFence === expected.repositoryFence && current.revisionFence === expected.revisionFence;
}
