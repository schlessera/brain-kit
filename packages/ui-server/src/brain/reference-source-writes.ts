/** Reference catalog effects; acquisition and native pool calls stay with the caller (#2999). */
import type { Database } from "bun:sqlite";
import type { ReferenceAcquisition } from "./reference-acquisition.js";
import { authorityRepository, sourceAuthorityCurrent, type SourceAuthority } from "./reference-source-authority.js";

export function sourceWrites(db: Database) {
  function sourceView(domain: string, id: string): { id: string; hostPath: string | null } {
    const found = db.query("SELECT view_id, host_path FROM reference_views WHERE domain = ?").get(domain) as { view_id: string; host_path: string | null } | null;
    if (found) return { id: found.view_id, hostPath: found.host_path };
    db.query("INSERT INTO reference_views (domain, view_id) VALUES (?, ?)").run(domain, id);
    return { id, hostPath: null };
  }
  return {
    sourceView,
    sourceFence(domain: string, repository: string, revision: string, generation: string) {
      return db.transaction(() => {
        db.query(`INSERT INTO reference_authority_fences (domain, repository, revision, generation) VALUES (?, ?, ?, ?)
          ON CONFLICT (domain, repository, revision) DO UPDATE SET generation = excluded.generation`).run(domain, repository, revision, generation);
        // A crash after this commit must not leave old positive validation
        // available to startup recovery, including legacy GitHub casing aliases.
        const matches = (source: { repository: string; revision: string }) => {
          try { return (revision === "" || source.revision === revision) && authorityRepository(source.repository) === repository; }
          catch { return false; }
        };
        for (const source of db.query("SELECT repository, revision FROM reference_sources WHERE domain = ?").all(domain) as { repository: string; revision: string }[]) {
          if (matches(source))
            db.query("UPDATE reference_sources SET validated_at = 0 WHERE domain = ? AND repository = ? AND revision = ?").run(domain, source.repository, source.revision);
        }
        // Cleanup affects exactly the identities invalidated at this commit,
        // never a fresh acquisition that publishes while native hiding waits.
        return (db.query("SELECT id, state, repository, revision FROM reference_roots WHERE domain = ?").all(domain) as
          { id: string; state: string; repository: string; revision: string }[]).filter(matches);
      }).immediate();
    },
    sourceTouch(at: number, domain: string, repository: string, revision: string) {
      db.query("UPDATE reference_sources SET last_used_at = ? WHERE domain = ? AND repository = ? AND revision = ?").run(at, domain, repository, revision);
    },
    sourceForget(domain: string, repository: string, revision: string) {
      db.query("DELETE FROM reference_sources WHERE domain = ? AND repository = ? AND revision = ? AND root_id IS NULL").run(domain, repository, revision);
    },
    sourceReleaseRoot(id: string) {
      db.query("DELETE FROM reference_roots WHERE id = ?").run(id);
    },
    sourceDiscard(id: string) {
      return db.transaction(() => {
        const root = db.query("SELECT id, state FROM reference_roots WHERE id = ?").get(id) as { id: string; state: string } | null;
        db.query("UPDATE reference_sources SET root_id = NULL WHERE root_id = ?").run(id);
        db.query("UPDATE reference_roots SET state = 'superseded' WHERE id = ? AND state = 'published'").run(id);
        return root;
      }).immediate();
    },
    sourceValidate(at: number, refreshedAt: number, ref: string, domain: string, repository: string, revision: string, expected?: SourceAuthority, rootId?: string) {
      return db.transaction(() => {
        if (expected && !sourceAuthorityCurrent(db, expected)) return false;
        return db.query(`UPDATE reference_sources SET validated_at = ?, refreshed_at = ?, last_error = NULL, ref = ?
          WHERE domain = ? AND repository = ? AND revision = ? AND (? IS NULL OR root_id = ?)`)
          .run(at, refreshedAt, ref, domain, repository, revision, rootId ?? null, rootId ?? null).changes === 1;
      }).immediate();
    },
    sourceSuspend(domain: string, repository: string, revision: string) {
      db.query("UPDATE reference_sources SET validated_at = 0 WHERE domain = ? AND repository = ? AND revision = ?").run(domain, repository, revision);
    },
    sourceFailed(detail: string, at: number, domain: string, repository: string, revision: string) {
      db.query("UPDATE reference_sources SET last_error = ?, last_failed_at = ? WHERE domain = ? AND repository = ? AND revision = ?").run(detail, at, domain, repository, revision);
    },
    sourceStage(id: string, domain: string, repository: string, revision: string, at: number) {
      db.query("INSERT INTO reference_roots (id, domain, repository, revision, state, created_at) VALUES (?, ?, ?, ?, 'staging', ?)").run(id, domain, repository, revision, at);
    },
    sourceRevalidate(at: number, refreshedAt: number, domain: string, repository: string, revision: string, rootId: string) {
      db.query("UPDATE reference_sources SET validated_at = ?, refreshed_at = ?, last_error = NULL WHERE domain = ? AND repository = ? AND revision = ? AND root_id = ?").run(at, refreshedAt, domain, repository, revision, rootId);
    },
    sourceOpenView(path: string, domain: string) {
      db.query("UPDATE reference_views SET host_path = ? WHERE domain = ? AND host_path IS NULL").run(path, domain);
    },
    sourceWithdraw(domain: string, repository: string, revision: string, viewId: string) {
      db.query("UPDATE reference_sources SET root_id = NULL WHERE domain = ? AND repository = ? AND revision = ?").run(domain, repository, revision);
      const roots = db.query("SELECT id, state FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ?").all(domain, repository, revision) as { id: string; state: string }[];
      db.query("UPDATE reference_roots SET state = 'superseded' WHERE domain = ? AND repository = ? AND revision = ? AND state = 'published'").run(domain, repository, revision);
      const view = sourceView(domain, viewId);
      return { roots, view };
    },
    sourcePublish(path: string, domain: string, repository: string, revision: string, url: string, name: string, id: string, commit: string, ref: string, grantId: string | null, at: number, acquisition?: ReferenceAcquisition, expected?: SourceAuthority, publication?: { rootId: string | null }) {
      return db.transaction(() => {
        if (expected && !sourceAuthorityCurrent(db, expected)) return false;
        const current = db.query("SELECT root_id FROM reference_sources WHERE domain = ? AND repository = ? AND revision = ?").get(domain, repository, revision) as { root_id: string | null } | null;
        if (publication && (current?.root_id ?? null) !== publication.rootId) return false;
        if (acquisition) db.query(`INSERT INTO reference_acquisitions
          (root_id, acquisition_id, brain, principal_id, turn_id, repository_id, owner_id, owner, repository_name, ref, commit_id, tree_id,
            native_root_id, native_uuid, native_generation, grant_id, network_bytes, acquired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, acquisition.id, acquisition.brain,
            acquisition.principalId, acquisition.turnId, acquisition.identity.repositoryId, acquisition.identity.ownerId, acquisition.identity.owner,
            acquisition.identity.repository, ref, commit, acquisition.tree, acquisition.root.rootId, acquisition.root.uuid, acquisition.root.otransid,
            acquisition.grantId, acquisition.networkBytes, acquisition.at);
        db.query("UPDATE reference_views SET host_path = ? WHERE domain = ?").run(path, domain);
        db.query("UPDATE reference_roots SET state = 'superseded' WHERE domain = ? AND repository = ? AND revision = ? AND state = 'published'").run(domain, repository, revision);
        db.query("UPDATE reference_roots SET state = 'published' WHERE id = ?").run(id);
        db.query(`INSERT INTO reference_sources (domain, repository, revision, url, name, root_id, commit_id, ref, grant_id, refreshed_at, validated_at, last_error, last_failed_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
          ON CONFLICT (domain, repository, revision) DO UPDATE SET url = excluded.url, name = excluded.name, root_id = excluded.root_id, commit_id = excluded.commit_id,
            ref = excluded.ref, grant_id = excluded.grant_id, refreshed_at = excluded.refreshed_at, validated_at = excluded.validated_at, last_error = NULL`)
          .run(domain, repository, revision, url, name, id, commit, ref, grantId, at, at, at);
        return true;
      }).immediate();
    },
  };
}
