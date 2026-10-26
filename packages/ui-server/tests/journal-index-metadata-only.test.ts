/**
 * The brain's disposable index family is journaled by metadata only (#2873):
 * observation, before-version capture and history revert record its path,
 * size and change stamp and never retain, serve or restore its bytes, while
 * every other path, similarly named ones included, keeps its exact bytes.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { journalStatement } from "../src/brain/journal-store.js";
import type { JournalVersion } from "@schlessera/brain-ui-sdk/protocol";
import { createTurnReverts } from "../src/brain/turn-revert.js";
import { createJournalRoutes } from "../src/routes/journal.js";

/** The embeddings lock database beside the index and its sidecars joined the family in #2903. */
const LOCK = [".brain-index/brain.db.embedding-lock.db", ".brain-index/brain.db.embedding-lock.db-journal", ".brain-index/brain.db.embedding-lock.db-wal", ".brain-index/brain.db.embedding-lock.db-shm"];
const INDEX = [".brain-index/brain.db", ".brain-index/brain.db-wal", ".brain-index/brain.db-shm", ".brain-index/brain.db-journal", ...LOCK];
const COPY = ".brain-index/.maintenance-41b2dd7f-9913-4151-b5bf-53aad064cd96";
/** Authoritative controls: similar names inside and outside the index directory and another root's index. */
const CONTROLS = ["notes/odysseus.md", ".brain-index/notes.md", ".brain-index/brain.db.bak", ".brain-index/.maintenance-raft",
  "workspaces/raft/.brain-index/brain.db", "brain-index/brain.db", "notes/brain.db",
  ".brain-index/brain.db.embedding-lock.db.bak", ".brain-index/brain.db.embedding-lock", "notes/brain.db.embedding-lock.db", "workspaces/raft/.brain-index/brain.db.embedding-lock.db"];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "journal-index-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db"), objects = join(root, "objects");
  for (const directory of ["notes", ".brain-index", "workspaces/raft/.brain-index", "brain-index"]) mkdirSync(join(brain, directory), { recursive: true });
  writeFileSync(join(brain, "notes/odysseus.md"), "# Ithaca\n");
  for (const path of INDEX) writeFileSync(join(brain, path), "initial index");
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: objects });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  const reverts = createTurnReverts(db, { brainPath: brain, journal, gate: createWriterGate(db, brain, { pollMs: 1 }), lock: createKeyedLock(), isAuthorized: id => id === "odysseus", refresh() {} });
  /** Every content hash the journal could hold: its object rows, pins and stored object names. */
  const retained = () => {
    const names = new Set<string>();
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) { if (entry.isDirectory()) walk(join(directory, entry.name)); else names.add(entry.name); }
    };
    walk(objects);
    for (const row of db.query("SELECT hash FROM turn_journal_objects UNION SELECT hash FROM turn_journal_object_refs").all() as { hash: string }[]) names.add(row.hash);
    return names;
  };
  return { root, brain, db, journal, reverts, begin, retained, write: (path: string, bytes: Buffer | string) => writeFileSync(join(brain, path), bytes),
    async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("observed index refreshes keep path, size and change evidence without retaining or serving their bytes (#2873)", async () => {
  const f = fixture(), written = new Set<string>();
  try {
    // Two overlapping windows observe every refresh: a shared window must not
    // offer a conflict choice between versions that were never retained.
    await f.begin("refresh"); await f.begin("peer");
    for (let refresh = 0; refresh < 3; refresh++) {
      // The database changes size; the WAL keeps an equal size and only its stamp tells the versions apart.
      const sizes = [4096 + refresh, 8, 32, 16, 8192 + refresh, 512, 24, 40];
      INDEX.forEach((path, i) => { const bytes = Buffer.alloc(sizes[i]!, refresh + i + 1); written.add(sha(bytes)); f.write(path, bytes); });
      await f.journal.observe();
      const kept = f.retained();
      expect([...written].filter(hash => kept.has(hash)), `INDEX_BYTES_NOT_RETAINED_WHILE_ACTIVE ${refresh}`).toEqual([]);
    }
    const copy = Buffer.alloc(64, 9); written.add(sha(copy)); f.write(COPY, copy);
    // A symlink in the family keeps no target either: the target is its content.
    rmSync(join(f.brain, ".brain-index/brain.db-journal")); symlinkSync("../notes/odysseus.md", join(f.brain, ".brain-index/brain.db-journal"));
    for (const path of CONTROLS) f.write(path, `Penelope keeps ${path}\n`);
    await f.journal.finish("refresh"); await f.journal.finish("peer");

    const details = f.journal.details("ithaca", "refresh")!, routes = createJournalRoutes({ journal: f.journal });
    expect(details.summary.state, "INDEX_METADATA_ONLY_OBSERVATION_IS_COMPLETE").toBe("complete");
    expect(details.missing, "INDEX_METADATA_ONLY_IS_NOT_A_MISSING_VERSION").toEqual([]);
    const index = details.changes.filter(change => [...INDEX, COPY].includes(change.path));
    expect(index.filter(change => change.path === ".brain-index/brain.db").map(change => change.after?.bytes), "INDEX_SIZE_EVIDENCE_PER_REFRESH").toEqual([4096, 4097, 4098]);
    expect(index.filter(change => change.path === ".brain-index/brain.db-wal"), "INDEX_CHANGE_STAMP_DISTINGUISHES_EQUAL_SIZES").toHaveLength(3);
    expect(new Set(index.map(change => change.path)), "INDEX_FAMILY_AND_PUBLICATION_COPY_RECORDED").toEqual(new Set([...INDEX, COPY]));
    for (const change of index) {
      for (const side of ["before", "after"] as const) {
        const version = change[side];
        if (!version) continue;
        expect(version, `INDEX_VERSION_METADATA_ONLY ${change.path} ${side}`).toMatchObject({ ignored: false, metadataOnly: true });
        expect(version.hash, `INDEX_VERSION_HAS_NO_CONTENT_HASH ${change.path} ${side}`).toBeUndefined();
        expect(version.target, `INDEX_VERSION_HAS_NO_SYMLINK_TARGET ${change.path} ${side}`).toBeUndefined();
        expect(version.stamp, `INDEX_VERSION_RECORDS_CHANGE_STAMP ${change.path} ${side}`).toBeString();
        expect(f.journal.version("ithaca", "refresh", change.sequence, side), `INDEX_VERSION_NOT_SERVED ${change.path} ${side}`).toBeNull();
      }
      expect(change.conflict, `INDEX_SHARED_WINDOW_HAS_NO_CONFLICT_CHOICE ${change.path}`).toBeUndefined();
      const preview = await routes.request(`/sessions/ithaca/turns/refresh/journal/${change.sequence}/preview`);
      expect(await preview.json(), `INDEX_PREVIEW_REPORTS_METADATA_ONLY ${change.path}`).toEqual({ inline: false, reason: "metadata_only" });
      for (const side of ["before", "after"] as const)
        expect((await routes.request(`/sessions/ithaca/turns/refresh/journal/${change.sequence}/${side}`)).status, `INDEX_DOWNLOAD_UNAVAILABLE ${change.path} ${side}`).toBe(404);
    }
    const wal = index.filter(change => change.path === ".brain-index/brain.db-wal");
    expect(new Set(wal.map(change => change.after?.stamp)).size, "INDEX_EQUAL_SIZE_VERSIONS_HAVE_DISTINCT_STAMPS").toBe(3);
    expect(wal.every(change => change.before?.stamp !== change.after?.stamp), "INDEX_STAMP_CHANGES_WITH_EACH_REFRESH").toBe(true);
    expect(index.findLast(change => change.path === ".brain-index/brain.db-journal")?.after?.kind, "INDEX_SYMLINK_OBSERVED").toBe("symlink");
    const kept = f.retained();
    expect([...written].filter(hash => kept.has(hash)), "INDEX_BYTES_NEVER_RETAINED").toEqual([]);
    for (const path of CONTROLS) {
      const bytes = Buffer.from(`Penelope keeps ${path}\n`), change = details.changes.find(item => item.path === path)!;
      expect(change.after, `CONTROL_RETAINS_EXACT_BYTES ${path}`).toMatchObject({ kind: "file", hash: sha(bytes), bytes: bytes.length });
      expect(change.after!.metadataOnly, `CONTROL_IS_NOT_METADATA_ONLY ${path}`).toBeUndefined();
      expect(kept.has(sha(bytes)), `CONTROL_OBJECT_RETAINED ${path}`).toBe(true);
      expect(f.journal.version("ithaca", "refresh", change.sequence, "after")!.bytes(1024), `CONTROL_VERSION_SERVED ${path}`).toEqual(bytes);
      expect(await (await routes.request(`/sessions/ithaca/turns/refresh/journal/${change.sequence}/preview`)).json(), `CONTROL_PREVIEW_INLINE ${path}`).toMatchObject({ inline: true });
    }
  } finally { await f.close(); }
});

test("before-version capture and removal coverage never retain the index family, and keep ordinary originals (#2873)", async () => {
  const f = fixture();
  try {
    f.write(".brain-index/notes.md", "Athena's note beside the index\n"); f.write(COPY, "staged index");
    await f.begin("removal");
    expect(await f.journal.removalCoverage([".brain-index/brain.db", COPY, "notes/odysseus.md", ".brain-index/notes.md", LOCK[0]!]), "INDEX_FAMILY_NOT_REMOVAL_ELIGIBLE")
      .toEqual([false, false, true, true, false]);
    expect(await f.journal.removalCoverage([".brain-index/brain.db-wal", "notes/odysseus.md"], undefined, true), "INDEX_FAMILY_NOT_RESTORE_ALLOWED").toEqual([false, true]);
    expect(await f.journal.retainBefore("removal", ".brain-index/brain.db"), "INDEX_BEFORE_VERSION_NOT_RETAINED").toBeNull();
    expect(await f.journal.retainBefore("removal", COPY), "INDEX_COPY_BEFORE_VERSION_NOT_RETAINED").toBeNull();
    for (const path of LOCK) expect(await f.journal.retainBefore("removal", path), `LOCK_BEFORE_VERSION_NOT_RETAINED ${path}`).toBeNull();
    expect(f.retained().has(sha("initial index")) || f.retained().has(sha("staged index")), "INDEX_BEFORE_BYTES_NEVER_RETAINED").toBe(false);
    let original: JournalVersion | undefined;
    for (const [path, bytes] of [["notes/odysseus.md", "# Ithaca\n"], [".brain-index/notes.md", "Athena's note beside the index\n"]] as const) {
      const before = await f.journal.retainBefore("removal", path);
      expect(before, `CONTROL_BEFORE_VERSION_RETAINED ${path}`).toMatchObject({ kind: "file", hash: sha(bytes), bytes: bytes.length });
      expect(f.journal.hasRetainedVersion("removal", before!), `CONTROL_BEFORE_VERSION_VERIFIED ${path}`).toBe(true);
      original ??= before!;
    }
    // Even naming a genuinely retained object, a metadata-only version is never a recovery source.
    expect(f.journal.hasRetainedVersion("removal", { ...original!, metadataOnly: true }), "METADATA_ONLY_VERSION_NEVER_RETAINED").toBe(false);
    await expect(f.journal.withRetainedVersion({ ...original!, metadataOnly: true }, () => "copied"), "METADATA_ONLY_VERSION_NEVER_COPIED").rejects.toThrow("retained version is unavailable");
    await f.journal.finish("removal");
  } finally { await f.close(); }
});

test("history revert excludes the index family as metadata-only, including earlier retained versions, and restores ordinary bytes (#2873)", async () => {
  const f = fixture();
  try {
    await f.begin("return");
    f.write(".brain-index/brain.db", "refreshed index"); f.write(".brain-index/notes.md", "Telemachus\n"); f.write("notes/odysseus.md", "# Ithaca\nHome.\n");
    f.write(LOCK[0]!, "embedding lock taken"); f.write(".brain-index/brain.db.embedding-lock.db.bak", "Eumaeus\n");
    f.write("notes/harbour.md", "wal");
    await f.journal.finish("return");
    // A version retained before the ruling, whose object this turn still holds:
    // history keeps it, and still never restores it.
    const legacy = (f.db.query("SELECT max(sequence) AS sequence FROM turn_journal_changes WHERE turn_id='return'").get() as { sequence: number }).sequence + 1;
    await f.journal.writeOperation([journalStatement("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps) VALUES (?,?,?,?,?,?,?,?,?)",
      "return", legacy, ".brain-index/brain.db-wal", "", null, JSON.stringify({ kind: "file", mode: 0o644, bytes: 3, hash: sha("wal"), ignored: false }), "content", "agent", "[]")]);
    const legacyChange = f.journal.details("ithaca", "return")!.changes.find(change => change.sequence === legacy)!;
    expect(legacyChange.after, "LEGACY_INDEX_PRESENTED_METADATA_ONLY").toEqual({ kind: "file", mode: 0o644, bytes: 3, ignored: false, metadataOnly: true });
    expect(f.journal.version("ithaca", "return", legacy, "after"), "LEGACY_INDEX_BYTES_NOT_SERVED").toBeNull();
    expect(f.retained().has(sha("wal")), "LEGACY_OBJECT_NOT_ERASED").toBe(true);
    const plan = f.reverts.plan("ithaca", "return");
    const reason = (path: string) => plan.paths.find(item => item.path === path);
    expect(reason(".brain-index/brain.db"), "INDEX_REVERT_EXCLUDED_AS_METADATA_ONLY").toMatchObject({ state: "excluded", reason: "metadata_only" });
    expect(reason(".brain-index/brain.db-wal"), "LEGACY_RETAINED_INDEX_NEVER_RESTORED").toMatchObject({ state: "excluded", reason: "metadata_only" });
    expect(reason(".brain-index/notes.md"), "SIMILAR_PATH_REMAINS_REVERTIBLE").toMatchObject({ state: "eligible", reason: null });
    expect(reason(LOCK[0]!), "LOCK_REVERT_EXCLUDED_AS_METADATA_ONLY").toMatchObject({ state: "excluded", reason: "metadata_only" });
    expect(reason(".brain-index/brain.db.embedding-lock.db.bak"), "SIMILAR_LOCK_NAME_REMAINS_REVERTIBLE").toMatchObject({ state: "eligible", reason: null });
    expect(reason("notes/odysseus.md"), "CONTENT_REMAINS_REVERTIBLE").toMatchObject({ state: "eligible", reason: null });
    const receipt = await f.reverts.start("odysseus", "ithaca", "return", { id: "odysseus_index_revert_01" }); await f.reverts.idle(receipt.id);
    expect(f.reverts.receipt(receipt.id, "odysseus", "ithaca", "return")?.state, "REVERT_COMPLETES_WITHOUT_INDEX").toBe("complete");
    expect(readFileSync(join(f.brain, "notes/odysseus.md"), "utf8"), "CONTENT_RESTORED_EXACTLY").toBe("# Ithaca\n");
    expect(readFileSync(join(f.brain, ".brain-index/brain.db"), "utf8"), "INDEX_LEFT_FOR_REBUILD").toBe("refreshed index");
    expect(readFileSync(join(f.brain, LOCK[0]!), "utf8"), "LOCK_LEFT_IN_PLACE").toBe("embedding lock taken");
    expect(existsSync(join(f.brain, ".brain-index/brain.db.embedding-lock.db.bak")), "SIMILAR_LOCK_NAME_REVERTED").toBe(false);
    await expect(f.reverts.start("odysseus", "ithaca", "return", { id: "odysseus_index_revert_02", path: ".brain-index/brain.db" }), "INDEX_SINGLE_PATH_REVERT_REFUSED").rejects.toThrow();
  } finally { await f.close(); }
});
