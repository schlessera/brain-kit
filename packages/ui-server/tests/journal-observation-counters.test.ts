import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { JournalVersion } from "@schlessera/brain-ui-sdk/protocol";
import { JournalObservationCounters, type CounterChange } from "../src/brain/journal-observation-counters.js";
import { INDEX_FAMILY_PATHS, INDEX_PUBLICATION_COPY } from "../src/brain/native-journal-policy.js";

// Deliberately retain the pre-optimization SQL as an independent oracle,
// including legacy publication copies that disappear then return.
function recompute(db: Database) {
  const family = JSON.stringify(INDEX_FAMILY_PATHS);
  const counts = db.query<{ changedFiles: number; steeringFiles: number; keptFiles: number; sharedAttribution: number }, [string, string]>(`SELECT count(DISTINCT path) AS changedFiles,
    count(DISTINCT CASE WHEN class='steering' THEN path END) AS steeringFiles,
    count(DISTINCT CASE WHEN NOT (path IN (SELECT value FROM json_each(?)) OR path GLOB ?)
      AND coalesce(json_extract(before_json,'$.metadataOnly'),0)!=1 AND coalesce(json_extract(after_json,'$.metadataOnly'),0)!=1
      AND coalesce(json_extract(before_json,'$.ignored'),0)!=1 AND coalesce(json_extract(after_json,'$.ignored'),0)!=1
      AND coalesce(json_extract(before_json,'$.kind'),json_extract(after_json,'$.kind'))!='other' THEN path END) AS keptFiles,
    max(overlaps!='[]') AS sharedAttribution FROM changes`).get(family, INDEX_PUBLICATION_COPY);
  const facts = db.query<{ changedPaths: number; observedBytes: number; workspacePaths: number }, [string, string]>(`SELECT count(*) AS changedPaths,coalesce(sum(hashedBytes+ignoredBytes),0) AS observedBytes,
    count(*) FILTER (WHERE path GLOB 'workspaces/*') AS workspacePaths FROM (
    SELECT path,sum(CASE WHEN json_extract(after_json,'$.kind')='file' AND coalesce(json_extract(after_json,'$.ignored'),0)!=1 AND NOT disposable
      AND json_extract(after_json,'$.hash') IS NOT json_extract(before_json,'$.hash') THEN json_extract(after_json,'$.bytes') ELSE 0 END) AS hashedBytes,
    max(CASE WHEN json_extract(after_json,'$.kind')='file' AND (json_extract(after_json,'$.ignored')=1 OR disposable) THEN json_extract(after_json,'$.bytes') ELSE 0 END) AS ignoredBytes
    FROM (SELECT *,(path IN (SELECT value FROM json_each(?)) OR coalesce(json_extract(after_json,'$.metadataOnly'),0)=1) AS disposable
      FROM changes AS change WHERE NOT (path GLOB ? AND (SELECT after_json FROM changes WHERE path=change.path ORDER BY sequence DESC LIMIT 1) IS NULL)) GROUP BY path)`)
    .get(family, INDEX_PUBLICATION_COPY);
  return { counts: counts!, facts: facts! };
}
test("delta counters equal full recomputation across repeated versions, ignored files, publication copies and independent worktrees", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE changes (sequence INTEGER PRIMARY KEY,path TEXT,before_json TEXT,after_json TEXT,class TEXT,overlaps TEXT); CREATE INDEX paths ON changes(path,sequence)");
  const counters = new JournalObservationCounters();
  let seed = 4278;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const paths = ["notes/ithaca.md", "notes/scheria.md", "workspaces/raft/chart.md", "workspaces-old/chart.md", ".brain-index/brain.db", ".brain-index/.maintenance-41b2dd7f-9913-4151-b5bf-53aad064cd96", "reference-worktree://raft/chart.md", "reference-worktree://loom/.brain-index/brain.db", "scratch/ignored.txt"];
  const current = new Map<string, JournalVersion | null>();
  try {
    for (let sequence = 1; sequence <= 1200; sequence++) {
      const path = paths[sequence <= paths.length ? sequence - 1 : random() % paths.length]!;
      const before = current.get(path) ?? null;
      const ignored = random() % 4 === 0, metadataOnly = path.startsWith(".brain-index/");
      const after: JournalVersion | null = sequence % 7 === 0 ? null : { kind: sequence % 13 === 0 ? "other" : "file", mode: 0o644, bytes: random() % 1000, ignored,
        ...(metadataOnly ? { metadataOnly: true, stamp: String(sequence) } : !ignored ? { hash: String(random() % 9).padStart(64, "0") } : {}) };
      const row: CounterChange = { sequence, path, before_json: before ? JSON.stringify(before) : null, after_json: after ? JSON.stringify(after) : null, class: sequence % 5 === 0 ? "steering" : "content", overlaps: sequence % 3 === 0 ? '["peer"]' : "[]" };
      db.query("INSERT INTO changes VALUES (?,?,?,?,?,?)").run(row.sequence, path, row.before_json, row.after_json, row.class, row.overlaps);
      current.set(path, after); counters.append([row]);
      const expected = recompute(db);
      expect({ ...counters.counts, sharedAttribution: Number(counters.counts.sharedAttribution > 0) }, `COUNTERS_EQUAL_RECOMPUTATION_${sequence}`).toEqual(expected.counts);
      expect(counters.facts, `SCOPE_EQUAL_RECOMPUTATION_${sequence}`).toEqual(expected.facts);
      // Re-reading a committed delta is idempotent.
      counters.append([row]);
    }
  } finally { db.close(); }
});

test("one new version processes one delta after ten thousand rows", () => {
  const counters = new JournalObservationCounters();
  const row = (sequence: number): CounterChange => ({ sequence, path: `notes/voyage-${sequence % 300}.md`, before_json: null, after_json: '{"kind":"file","bytes":4,"hash":"a","ignored":false}', class: "content", overlaps: "[]" });
  counters.append(Array.from({ length: 10000 }, (_, i) => row(i + 1)));
  const start = performance.now();
  counters.append([row(10001)]);
  console.log("JOURNAL_10000_ROW_DELTA", JSON.stringify({ addedRows: 1, elapsedMs: performance.now() - start }));
  expect(counters.sequence).toBe(10001);
  expect(counters.facts).toEqual({ changedPaths: 300, observedBytes: 40004, workspacePaths: 0 });
  expect(counters.counts.keptFiles).toBe(300);
});
