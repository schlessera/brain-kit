/** Reference catalog effects; acquisition and native pool calls stay with the caller (#2999). */
import type { Database } from "bun:sqlite";

export function sourceWrites(db: Database) {
  function sourceView(domain: string, id: string): { id: string; hostPath: string | null } {
    const found = db.query("SELECT view_id, host_path FROM reference_views WHERE domain = ?").get(domain) as { view_id: string; host_path: string | null } | null;
    if (found) return { id: found.view_id, hostPath: found.host_path };
    db.query("INSERT INTO reference_views (domain, view_id) VALUES (?, ?)").run(domain, id);
    return { id, hostPath: null };
  }
  return {
    sourceView,
    sourceTouch(at: number, domain: string, repository: string, revision: string) {
      db.query("UPDATE reference_sources SET last_used_at = ? WHERE domain = ? AND repository = ? AND revision = ?").run(at, domain, repository, revision);
    },
    sourceForget(domain: string, repository: string, revision: string) {
      db.query("DELETE FROM reference_sources WHERE domain = ? AND repository = ? AND revision = ? AND root_id IS NULL").run(domain, repository, revision);
    },
    sourceReleaseRoot(id: string) {
      db.query("DELETE FROM reference_roots WHERE id = ?").run(id);
    },
    sourceValidate(at: number, refreshedAt: number, ref: string, domain: string, repository: string, revision: string) {
      db.query("UPDATE reference_sources SET validated_at = ?, refreshed_at = ?, last_error = NULL, ref = ? WHERE domain = ? AND repository = ? AND revision = ?").run(at, refreshedAt, ref, domain, repository, revision);
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
      const roots = db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ? AND state != 'staging'").all(domain, repository, revision) as { id: string }[];
      db.query("UPDATE reference_roots SET state = 'superseded' WHERE domain = ? AND repository = ? AND revision = ? AND state = 'published'").run(domain, repository, revision);
      const view = sourceView(domain, viewId);
      return { roots, view };
    },
    sourcePublish(path: string, domain: string, repository: string, revision: string, url: string, name: string, id: string, commit: string, ref: string, grantId: string | null, at: number) {
      db.transaction(() => {
        db.query("UPDATE reference_views SET host_path = ? WHERE domain = ?").run(path, domain);
        db.query("UPDATE reference_roots SET state = 'superseded' WHERE domain = ? AND repository = ? AND revision = ? AND state = 'published'").run(domain, repository, revision);
        db.query("UPDATE reference_roots SET state = 'published' WHERE id = ?").run(id);
        db.query(`INSERT INTO reference_sources (domain, repository, revision, url, name, root_id, commit_id, ref, grant_id, refreshed_at, validated_at, last_error, last_failed_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
          ON CONFLICT (domain, repository, revision) DO UPDATE SET url = excluded.url, name = excluded.name, root_id = excluded.root_id, commit_id = excluded.commit_id,
            ref = excluded.ref, grant_id = excluded.grant_id, refreshed_at = excluded.refreshed_at, validated_at = excluded.validated_at, last_error = NULL`)
          .run(domain, repository, revision, url, name, id, commit, ref, grantId, at, at, at);
      }).immediate();
    },
  };
}
