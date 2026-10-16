import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStorageReferences } from "../src/queries";

test("Storage references are bounded resolved-link evidence from a read-only index", () => {
  const root = mkdtempSync(join(tmpdir(), "storage-odysseus-")), db = new Database(join(root, "brain.db"));
  try {
    db.exec(`CREATE TABLE index_metadata(key TEXT,value TEXT); INSERT INTO index_metadata VALUES('schema_version','3');
      CREATE TABLE documents(id INTEGER PRIMARY KEY,path TEXT,title TEXT,type TEXT,summary TEXT,updated TEXT,indexed_at TEXT);
      CREATE TABLE links(source_id INTEGER,target_id INTEGER,target TEXT);
      INSERT INTO documents VALUES(1,'Troy.pdf','Chart','asset',NULL,NULL,'2026-07-12T00:00:00Z');`);
    const add = db.query("INSERT INTO documents VALUES(?,?,?,'note',NULL,NULL,'2026-07-12T00:00:00Z')"), link = db.query("INSERT INTO links VALUES(?,1,'Troy.pdf')");
    db.transaction(() => { for (let i = 0; i < 205; i++) { add.run(i + 2, `notes/chart-${i}.md`, "Odysseus chart"); link.run(i + 2); } })();
    const result = readStorageReferences({ brainPath: root, path: "Troy.pdf" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.code);
    expect(result.value.sources, "STORAGE_REFERENCE_LIMIT").toHaveLength(200);
    expect(result.value.truncated).toBe(true);
    expect(result.value.sources[0]?.indexedAt).toBe("2026-07-12T00:00:00Z");
    expect(readStorageReferences({ brainPath: root, path: "Ithaca.pdf" })).toMatchObject({ ok: true, value: { sources: [], truncated: false } });
    const redirected = join(root, "other"); mkdirSync(redirected); symlinkSync(join(root, "brain.db"), join(redirected, "brain.db"));
    expect(readStorageReferences({ brainPath: redirected, path: "Troy.pdf" }).ok, "STORAGE_REFERENCE_INDEX_SYMLINK_REFUSED").toBe(false);
    expect(readStorageReferences({ brainPath: root, path: "../Troy.pdf" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
