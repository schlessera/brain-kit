import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import * as journalStore from "../src/brain/journal-store.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const CANDIDATES = "SELECT hash,bytes FROM turn_journal_objects WHERE state='present' AND hash NOT IN (SELECT hash FROM turn_journal_object_refs) AND hash NOT IN (SELECT hash FROM turn_journal_reservations WHERE hash IS NOT NULL)";

/** The actual migrated journal schema, with separately pinned and collectible objects. */
function seed(db: Database, pins: number, freed: number) {
  db.transaction(() => {
    const object = db.query("INSERT INTO turn_journal_objects VALUES (?,0,'present')");
    for (let i = 0; i < 50; i++) object.run(sha(`Ithaca pin ${i}`));
    for (let i = 0; i < freed; i++) object.run(sha(`Ithaca unused ${i}`));
    const turn = db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,ended_at,state) VALUES (?,'interactive','governed',1,2,'complete')");
    const pin = db.query("INSERT INTO turn_journal_object_refs VALUES (?,?)");
    for (let i = 0; i < Math.ceil(pins / 50); i++) {
      const id = `voyage-${i}`; turn.run(id);
      for (let j = 0; j < Math.min(50, pins - i * 50); j++) pin.run(id, sha(`Ithaca pin ${j}`));
    }
  }).immediate();
}

test("ordinary collection uses indexed foreign-key checks, independently of pin count (#2913)", () => {
  const timings: { pins: number; candidates: number; collection: number }[] = [];
  for (const pins of [1_000, 100_000]) {
    const root = mkdtempSync(join(tmpdir(), "journal-object-index-odysseus-")), db = createUiDb(":memory:");
    let store: ReturnType<typeof journalStore.setup> | undefined;
    try {
      seed(db, pins, 2_000);
      store = journalStore.setup(db, { dbPath: ":memory:", objectsRoot: join(root, "objects") });
      const candidatePlan = db.query(`EXPLAIN QUERY PLAN ${CANDIDATES}`).all();
      const deletePlan = db.query("EXPLAIN QUERY PLAN DELETE FROM turn_journal_objects WHERE hash=?").all(sha("Ithaca unused 0"));
      const started = performance.now();
      expect(db.query(CANDIDATES).all()).toHaveLength(2_000);
      const selected = performance.now();
      store.collectObjects!();
      const collected = performance.now();
      const timing = { pins, candidates: selected - started, collection: collected - selected };
      timings.push(timing);
      console.log(JSON.stringify({ ...timing, candidatePlan, deletePlan }));
      expect(db.query("SELECT count(*) AS n FROM turn_journal_objects").get(), "COLLECTION_KEEPS_ALL_PINNED_OBJECTS").toEqual({ n: 50 });
      expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs").get(), "COLLECTION_KEEPS_ALL_PINS").toEqual({ n: pins });
      expect(db.query("PRAGMA foreign_keys").get(), "COLLECTION_FOREIGN_KEYS_ENABLED").toEqual({ foreign_keys: 1 });
      // Main takes several seconds for 2,000 * 100,000 child-key visits;
      // the indexed path takes tens of milliseconds, including the candidate scan.
      expect(timing.collection, "COLLECTION_NO_PER_OBJECT_PIN_SCAN").toBeLessThan(1_500);
      expect(JSON.stringify(deletePlan), "COLLECTION_FK_LOOKUP_USES_HASH_INDEX").toContain("turn_journal_object_refs_hash");
      expect(db.query("PRAGMA journal.foreign_key_check").all()).toEqual([]);
    } finally { store?.close?.(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }
  // Candidate selection visits the pin set once. Increasing it 100-fold
  // must not multiply the 2,000 foreign-key checks by 100.
  expect(timings[1]!.collection, "COLLECTION_PIN_COUNT_DOES_NOT_MULTIPLY_DELETES").toBeLessThan(timings[0]!.collection * 12 + 300);
});
